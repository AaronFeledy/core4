import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema, type Scope, Stream } from "effect";

import { CapabilityError, DataEndpointUnsupportedError } from "../errors/index.ts";
import { followLogSources, logFollowLineChunks, makeMemoryLogFileAccess } from "../log-follow/index.ts";
import {
  AbsolutePath,
  AppId,
  type DataEndpoint,
  type DataStoreMountPlan,
  PortablePath,
  ProviderId,
  type ServiceName,
  type StorageScope,
  type VolumeInfo,
  type VolumeRef,
  type VolumeSnapshotRef,
} from "../schema/index.ts";
import type { ExecChunk, LogChunk, RuntimeProviderShape } from "../services/index.ts";
import {
  type ContractFailure,
  TEST_APP_ID,
  TEST_PROVIDER_ID,
  TEST_SERVICE_NAME,
  TEST_VOLUME_PATH,
  bytesEqual,
  cloneBytes,
  collectByteStream,
  collectStdoutBytes,
  concatBytes,
  contractFailure,
  decodeUtf8,
  makeTestAppPlan,
  mapProviderFailure,
  mapProviderOrContractFailure,
  requireContract,
  sampleBytes,
  streamBytes,
  testCapabilities,
  utf8,
} from "./_shared.ts";

export interface ProviderDataPlaneContractInput {
  readonly providerName?: string;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
  readonly observations?: {
    readonly usedNativeVolumeSnapshot?: () => boolean;
    readonly usedCopyVolumeSnapshot?: () => boolean;
    readonly usedNativeServiceFileCopy?: () => boolean;
  };
}

const endpointKind = (endpoint: DataEndpoint): string => endpoint._tag;

const unsupportedDataPlanePair = (
  from: DataEndpoint,
  to: DataEndpoint,
): Effect.Effect<never, DataEndpointUnsupportedError> =>
  Effect.fail(
    new DataEndpointUnsupportedError({
      message: `Cannot transfer ${endpointKind(from)} to ${endpointKind(to)} with the provider data-plane contract fixture.`,
      fromEndpoint: endpointKind(from),
      toEndpoint: endpointKind(to),
      remediation: "Use DataMover with a supported endpoint pair or provide a matching native capability.",
    }),
  );

const requireGenericVolumeFallback = (
  provider: RuntimeProviderShape,
): Effect.Effect<void, CapabilityError> =>
  provider.capabilities.ephemeralMounts
    ? Effect.void
    : Effect.fail(
        new CapabilityError({
          message: "Provider data-plane contract requires ephemeral mounts.",
          feature: "provider data-plane contract",
          capability: "ephemeralMounts",
          providerId: provider.id,
          remediation: "Implement EphemeralRunSpec.mounts before running the shared data-plane contract.",
        }),
      );

const nextContractRunId = (): string => {
  return `contract-data-${randomUUID()}`;
};

const dataStoreMount = (store: string): DataStoreMountPlan => ({
  store,
  target: Schema.decodeUnknownSync(PortablePath)("/data"),
  readOnly: false,
});

const writeMountedVolume = (
  provider: RuntimeProviderShape,
  store: string,
  payload: Uint8Array,
): Effect.Effect<void, unknown | ContractFailure, Scope.Scope> =>
  provider
    .run({
      image: "alpine:3.20",
      command: ["sh", "-c", "cat > /data/payload"],
      mounts: [dataStoreMount(store)],
      stdinStream: streamBytes(payload),
      remove: true,
    })
    .pipe(
      Effect.flatMap((result) =>
        requireContract(
          result.exitCode === 0,
          "volume import via EphemeralRunSpec.stdinStream exits successfully",
          {
            exitCode: result.exitCode,
          },
        ),
      ),
    );

const readMountedVolume = (
  provider: RuntimeProviderShape,
  store: string,
): Effect.Effect<Uint8Array, unknown | ContractFailure, Scope.Scope> =>
  collectStdoutBytes(
    provider.runStream({
      image: "alpine:3.20",
      command: ["sh", "-c", "cat /data/payload"],
      mounts: [dataStoreMount(store)],
      captureStdout: true,
      remove: true,
    }),
  );

const withTempCopySource = <A, E, R>(
  payload: Uint8Array,
  use: (path: AbsolutePath) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "lando-provider-contract-"));
      const path = join(directory, "payload.bin");
      await writeFile(path, payload);
      return { directory, path: Schema.decodeUnknownSync(AbsolutePath)(path) };
    }),
    ({ path }) => use(path),
    ({ directory }) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );

export const runProviderDataPlaneContract = (
  input: ProviderDataPlaneContractInput,
): Effect.Effect<void, ContractFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const provider = yield* input
        .factory()
        .pipe(
          Effect.mapError(
            mapProviderFailure(`${input.providerName ?? "provider"} data-plane factory resolves`),
          ),
        );
      const store = nextContractRunId();
      const serviceTarget = {
        app: TEST_APP_ID,
        service: TEST_SERVICE_NAME,
        plan: makeTestAppPlan(ProviderId.make(provider.id)),
      };
      const volumePayload = sampleBytes(0, 1, 2, 3, 128, 255);
      const mutatedPayload = sampleBytes(255, 128, 3, 2, 1, 0);
      const servicePayload = sampleBytes(9, 8, 7, 6, 5, 4);
      const artifactPayload = sampleBytes(4, 5, 6, 7, 8, 9);

      yield* requireContract(
        provider.capabilities.volumeSnapshot !== "none",
        "data-plane provider declares volume snapshot support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.serviceFileCopy !== "none",
        "data-plane provider declares service file copy support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.artifactExport,
        "data-plane provider declares artifact export support",
        provider.capabilities,
      );
      yield* requireContract(
        provider.capabilities.artifactImport,
        "data-plane provider declares artifact import support",
        provider.capabilities,
      );

      const unsupportedExit = yield* Effect.exit(
        unsupportedDataPlanePair(
          { _tag: "artifact", ref: "web:test" },
          {
            _tag: "servicePath",
            app: TEST_APP_ID,
            service: TEST_SERVICE_NAME,
            path: TEST_VOLUME_PATH,
          },
        ),
      );
      yield* requireContract(
        unsupportedExit._tag === "Failure" &&
          unsupportedExit.cause._tag === "Fail" &&
          unsupportedExit.cause.error instanceof DataEndpointUnsupportedError,
        "unrealizable transfer fails DataEndpointUnsupportedError",
        unsupportedExit,
      );

      yield* requireGenericVolumeFallback(provider).pipe(
        Effect.mapError((error) =>
          contractFailure("data-plane contract without ephemeral mounts fails CapabilityError", error),
        ),
      );

      yield* writeMountedVolume(provider, store, volumePayload).pipe(
        Effect.mapError(
          mapProviderOrContractFailure("volume import via EphemeralRunSpec.stdinStream succeeds"),
        ),
      );
      const exportedVolume = yield* readMountedVolume(provider, store).pipe(
        Effect.mapError(mapProviderFailure("volume export via runStream succeeds")),
      );
      yield* requireContract(
        bytesEqual(exportedVolume, volumePayload),
        "importVolume(exportVolume(x)) == x",
        { expected: Array.from(volumePayload), actual: Array.from(exportedVolume) },
      );

      const snapshot = yield* provider
        .snapshotVolume({ volume: { app: TEST_APP_ID, store } })
        .pipe(Effect.mapError(mapProviderFailure("snapshotVolume succeeds")));
      if (
        provider.capabilities.volumeSnapshot === "native" &&
        input.observations?.usedNativeVolumeSnapshot !== undefined
      ) {
        yield* requireContract(
          input.observations.usedNativeVolumeSnapshot(),
          "native volume snapshots use the provider-native path",
          provider.capabilities,
        );
      }
      if (
        provider.capabilities.volumeSnapshot === "copy" &&
        input.observations?.usedCopyVolumeSnapshot !== undefined
      ) {
        yield* requireContract(
          input.observations.usedCopyVolumeSnapshot(),
          "copy-mode volume snapshots use the verified archive path",
          provider.capabilities,
        );
      }
      yield* writeMountedVolume(provider, store, mutatedPayload).pipe(
        Effect.mapError(
          mapProviderOrContractFailure("volume mutation via EphemeralRunSpec.stdinStream succeeds"),
        ),
      );
      yield* provider
        .restoreVolume({
          snapshot,
          target: { app: TEST_APP_ID, store },
          overwrite: true,
        })
        .pipe(Effect.mapError(mapProviderFailure("restoreVolume succeeds")));
      const restoredVolume = yield* readMountedVolume(provider, store).pipe(
        Effect.mapError(mapProviderFailure("restored volume export via runStream succeeds")),
      );
      yield* requireContract(
        bytesEqual(restoredVolume, volumePayload),
        "snapshot -> mutate -> restore restores volume bytes",
        { expected: Array.from(volumePayload), actual: Array.from(restoredVolume) },
      );

      yield* withTempCopySource(servicePayload, (sourcePath) =>
        provider.copyToService(serviceTarget, { sourcePath, targetPath: TEST_VOLUME_PATH, overwrite: true }),
      ).pipe(Effect.mapError(mapProviderFailure("copyToService succeeds")));
      if (
        provider.capabilities.serviceFileCopy === "native" &&
        input.observations?.usedNativeServiceFileCopy !== undefined
      ) {
        yield* requireContract(
          input.observations.usedNativeServiceFileCopy(),
          "native service file copy uses the provider-native path",
          provider.capabilities,
        );
      }
      const copiedServiceBytes = yield* collectByteStream(
        provider.copyFromService(serviceTarget, { sourcePath: TEST_VOLUME_PATH }),
      ).pipe(Effect.mapError(mapProviderFailure("copyFromService succeeds")));
      yield* requireContract(
        bytesEqual(copiedServiceBytes, servicePayload),
        "copyToService/copyFromService round-trips bytes",
        { expected: Array.from(servicePayload), actual: Array.from(copiedServiceBytes) },
      );

      const importedArtifact = yield* provider
        .importArtifact(Stream.make(artifactPayload))
        .pipe(Effect.mapError(mapProviderFailure("importArtifact succeeds")));
      const exportedArtifact = yield* collectByteStream(provider.exportArtifact(importedArtifact)).pipe(
        Effect.mapError(mapProviderFailure("exportArtifact succeeds")),
      );
      yield* requireContract(
        bytesEqual(exportedArtifact, artifactPayload),
        "artifact export/import round-trips bytes",
        { expected: Array.from(artifactPayload), actual: Array.from(exportedArtifact) },
      );
    }),
  );

const testVolumeBytes = new Map<string, Uint8Array>();
const testSnapshotBytes = new Map<string, Uint8Array>();
const testServicePathBytes = new Map<string, Uint8Array>();
const testArtifactBytes = new Map<string, Uint8Array>();
let testArtifactImportCount = 0;

const volumeKey = (ref: {
  readonly app: AppId;
  readonly store: string;
  readonly scope?: string | undefined;
}): string => `${ref.app}:${ref.store}:${ref.scope ?? "app"}`;

const servicePathKey = (
  target: { readonly app: AppId; readonly service: ServiceName },
  path: PortablePath,
): string => `${target.app}:${target.service}:${path}`;

const firstDataStoreMount = (
  mounts: Parameters<RuntimeProviderShape["run"]>[0]["mounts"],
): DataStoreMountPlan | undefined =>
  Array.isArray(mounts) ? mounts.find((mount): mount is DataStoreMountPlan => "store" in mount) : undefined;

const storageScopeFromKey = (scope: string | undefined): StorageScope | undefined =>
  scope === "service" || scope === "app" || scope === "global" ? scope : undefined;

const volumeRef = (app: AppId, store: string, scope?: StorageScope | undefined): VolumeRef =>
  scope === undefined ? { app, store } : { app, store, scope };

const volumeInfo = (ref: VolumeRef, labels?: Readonly<Record<string, string>> | undefined): VolumeInfo =>
  labels === undefined ? { ref } : { ref, labels };

const collectAsyncBytes = (input: AsyncIterable<Uint8Array> | undefined): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const chunks: Uint8Array[] = [];
    if (input === undefined) return concatBytes(chunks);
    for await (const chunk of input) chunks.push(chunk);
    return concatBytes(chunks);
  });

const mountedVolumeKeyForSpec = (spec: Parameters<RuntimeProviderShape["run"]>[0]): string | undefined => {
  const mount = firstDataStoreMount(spec.mounts);
  return mount === undefined ? undefined : volumeKey({ app: TEST_APP_ID, store: mount.store });
};

const runTestEphemeral = (spec: Parameters<RuntimeProviderShape["run"]>[0]) =>
  Effect.gen(function* () {
    const command = spec.command.join(" ");
    const mountedVolumeKey = mountedVolumeKeyForSpec(spec);

    if (mountedVolumeKey !== undefined && command === "sh -c cat > /data/payload") {
      const payload = yield* collectAsyncBytes(spec.stdinStream);
      testVolumeBytes.set(mountedVolumeKey, cloneBytes(payload));
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (mountedVolumeKey !== undefined && command === "sh -c cat /data/payload") {
      return {
        exitCode: 0,
        stdout: decodeUtf8(testVolumeBytes.get(mountedVolumeKey) ?? utf8("")),
        stderr: "",
      };
    }

    return {
      exitCode: 0,
      stdout: spec.command.join(" "),
      stderr: "",
    };
  });

/**
 * In-memory `RuntimeProvider` reference implementation for SDK contract tests.
 */
export const TestRuntimeProvider: RuntimeProviderShape = {
  id: TEST_PROVIDER_ID,
  displayName: "Test Runtime Provider",
  version: "0.0.0-test",
  platform: "linux",
  capabilities: testCapabilities,

  isAvailable: Effect.succeed(true),
  planSetup: (_options) => Effect.succeed({ providerId: TEST_PROVIDER_ID, changes: [] }),
  setup: (_plan, _options) => Effect.void,
  getStatus: Effect.succeed({ running: true, message: "ready" }),
  getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test" }),

  buildArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: `${spec.service}:test` }),
  pullArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: spec.ref }),
  removeArtifact: (_ref) => Effect.void,

  apply: (_plan, _options) => Effect.succeed({ changed: false }),
  start: (_target) => Effect.void,
  stop: (_target) => Effect.void,
  restart: (_target) => Effect.void,
  destroy: (_target, _options) => Effect.void,

  exec: (_target, command) =>
    Effect.succeed({
      exitCode: 0,
      stdout: command.command.join(" "),
      stderr: "",
    }),
  execStream: (_target, command) => {
    const stdoutChunk: ExecChunk = {
      kind: "stdout",
      chunk: new TextEncoder().encode(command.command.join(" ")),
    };
    const exitChunk: ExecChunk = { exitCode: 0 };

    return Stream.make(stdoutChunk, exitChunk);
  },
  run: (spec) => runTestEphemeral(spec),
  runStream: (spec) => {
    const command = spec.command.join(" ");
    const mountedVolumeKey = mountedVolumeKeyForSpec(spec);
    if (mountedVolumeKey !== undefined && command === "sh -c cat /data/payload") {
      const stdoutChunk: ExecChunk = {
        kind: "stdout",
        chunk: cloneBytes(testVolumeBytes.get(mountedVolumeKey) ?? utf8("")),
      };
      const exitChunk: ExecChunk = { exitCode: 0 };

      return Stream.make(stdoutChunk, exitChunk);
    }

    return Stream.unwrap(
      runTestEphemeral(spec).pipe(
        Effect.map((result) => {
          const stdoutChunk: ExecChunk = {
            kind: "stdout",
            chunk: utf8(result.stdout),
          };
          const exitChunk: ExecChunk = { exitCode: result.exitCode };

          return Stream.make(stdoutChunk, exitChunk);
        }),
      ),
    );
  },
  logs: (target, options) => {
    const consoleChunk: LogChunk = {
      service: target.service,
      stream: "stdout",
      line: "ready",
    };

    const sources = options.sources ?? [];
    const followSources = sources.filter((source) => source.strategy === "follow");
    if (followSources.length === 0) return Stream.make(consoleChunk);

    const fs = makeMemoryLogFileAccess();
    for (const source of followSources) {
      fs.writeFile(String(source.path), `follow:${String(source.id)}\n`);
    }

    const followers = logFollowLineChunks(
      followLogSources({
        service: target.service,
        sources,
        follow: options.follow,
        access: fs.access,
        ...(options.tail === undefined ? {} : { tail: options.tail }),
        ...(options.source === undefined ? {} : { source: options.source }),
      }),
    );

    return Stream.concat(Stream.make(consoleChunk), followers);
  },
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: TEST_PROVIDER_ID,
      status: "running",
    }),
  list: (filter) =>
    Effect.succeed([
      {
        app: filter.app ?? TEST_APP_ID,
        service: TEST_SERVICE_NAME,
        providerId: TEST_PROVIDER_ID,
        status: "running",
      },
    ]),
  snapshotVolume: (spec) =>
    Effect.sync(() => {
      const id = spec.snapshotId ?? `${spec.volume.store}-snapshot`;
      testSnapshotBytes.set(id, cloneBytes(testVolumeBytes.get(volumeKey(spec.volume)) ?? utf8("")));
      return { provider: TEST_PROVIDER_ID, id };
    }),
  removeVolumeSnapshot: (snapshot: VolumeSnapshotRef) =>
    Effect.sync(() => {
      testSnapshotBytes.delete(snapshot.id);
    }),
  restoreVolume: (spec) =>
    Effect.sync(() => {
      testVolumeBytes.set(
        volumeKey(spec.target),
        cloneBytes(testSnapshotBytes.get(spec.snapshot.id) ?? utf8("")),
      );
    }),
  listVolumes: (filter) =>
    Effect.sync(() => {
      const volumes = Array.from(testVolumeBytes.keys()).map((key) => {
        const [app, store, scope] = key.split(":");
        return volumeInfo(
          volumeRef(AppId.make(app ?? String(TEST_APP_ID)), store ?? "data", storageScopeFromKey(scope)),
          filter.labels,
        );
      });
      return volumes.length > 0
        ? volumes
        : [
            volumeInfo(
              volumeRef(filter.app ?? TEST_APP_ID, filter.store ?? "data", filter.scope),
              filter.labels,
            ),
          ];
    }),
  removeVolume: (ref) =>
    Effect.sync(() => {
      testVolumeBytes.delete(volumeKey(ref));
    }),
  copyToService: (target, spec) =>
    Effect.promise(async () => {
      const payload = await readFile(spec.sourcePath);
      testServicePathBytes.set(servicePathKey(target, spec.targetPath), cloneBytes(payload));
    }),
  copyFromService: (target, spec) =>
    Stream.make(cloneBytes(testServicePathBytes.get(servicePathKey(target, spec.sourcePath)) ?? utf8(""))),
  exportArtifact: (ref) => Stream.make(cloneBytes(testArtifactBytes.get(ref.ref) ?? utf8(ref.ref))),
  importArtifact: (data) =>
    Effect.gen(function* () {
      const payload = yield* collectByteStream(data);
      testArtifactImportCount += 1;
      const ref = `imported:${testArtifactImportCount}`;
      testArtifactBytes.set(ref, cloneBytes(payload));
      return { providerId: TEST_PROVIDER_ID, ref };
    }),
};
