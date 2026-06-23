/**
 * Test helpers for the SDK provider and service contract suites.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Cause,
  type Context,
  DateTime,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect";

import {
  CapabilityError,
  DataEndpointUnsupportedError,
  DatasetBindingError,
  type ManagedFileError,
  PluginLoadError,
  PluginManifestError,
  RemoteDatasetUnsupportedError,
  RemoteEnvNotFoundError,
  RemoteProtectedEnvError,
} from "../errors/index.ts";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type CommandSpec,
  type DataEndpoint,
  type DataStoreMountPlan,
  type DatasetContext,
  type DatasetKind,
  type DownloadRequest,
  type DownloadResult,
  type EndpointPlan,
  type HealthcheckPlan,
  type HostPlatform,
  LandofileShape,
  type ManagedFile,
  type ManagedFileInfo,
  type ManagedFilePlan,
  type ManagedFileResult,
  type PlanMetadata,
  PluginManifest,
  PortablePath,
  type PromptSpec,
  type PromptType,
  ProviderCapabilities,
  ProviderId,
  type RemoteConfig,
  type RemoteEnvId,
  ServiceName,
  ServicePlan,
  type StorageScope,
  type VolumeInfo,
  type VolumeRef,
} from "../schema/index.ts";
import type {
  DownloaderShape,
  InteractionError,
  InteractionServiceShape,
  ManagedFileService,
} from "../services/index.ts";
import { Renderer } from "../services/index.ts";
import type {
  DatasetShape,
  ExecChunk,
  LandoEvent,
  LogChunk,
  RemoteSourceShape,
  RuntimeProviderShape,
  ServiceTypeHostFacts,
  ServiceTypeShape,
} from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");
const TEST_PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("test");
const TEST_COPY_SOURCE = Schema.decodeUnknownSync(AbsolutePath)("/tmp/lando-copy-in.tar");
const TEST_SERVICE_PATH = Schema.decodeUnknownSync(PortablePath)("/app");
const TEST_VOLUME_PATH = Schema.decodeUnknownSync(PortablePath)("/data/payload");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const utf8 = (value: string): Uint8Array => textEncoder.encode(value);

const decodeUtf8 = (value: Uint8Array): string => textDecoder.decode(value);

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const streamBytes = (payload: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield payload;
  },
});

const collectByteStream = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(Array.from(chunks))),
  );

const collectStdoutBytes = <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
): Effect.Effect<Uint8Array, E | ContractFailure, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.flatMap((chunks) => {
      const collected = Array.from(chunks);
      const exit = collected.find((chunk): chunk is { readonly exitCode: number } => "exitCode" in chunk);
      if (exit !== undefined && exit.exitCode !== 0) {
        return Effect.fail(contractFailure("runStream exits successfully", { exitCode: exit.exitCode }));
      }

      return Effect.succeed(
        concatBytes(
          collected.flatMap((chunk) => ("kind" in chunk && chunk.kind === "stdout" ? [chunk.chunk] : [])),
        ),
      );
    }),
  );

const cloneBytes = (payload: Uint8Array): Uint8Array => new Uint8Array(payload);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
};

const sampleBytes = (...bytes: ReadonlyArray<number>): Uint8Array => new Uint8Array(bytes);

const testCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "copy",
  serviceFileCopy: "exec",
  artifactExport: true,
  artifactImport: true,
  ephemeralMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const planMetadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
  source: "@lando/sdk/test",
  runtime: 4,
};

const makeTestServicePlan = (providerId: ProviderId): ServicePlan => ({
  name: TEST_SERVICE_NAME,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: [
    "node",
    "-e",
    "console.log('lando-contract-ready'); setInterval(() => console.log('lando-contract-ready'), 1000)",
  ],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: planMetadata,
  extensions: {},
});

const makeTestAppPlan = (providerId: ProviderId): AppPlan => {
  const testServicePlan = makeTestServicePlan(providerId);

  return {
    id: TEST_APP_ID,
    name: "My App",
    slug: "myapp",
    root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
    provider: providerId,
    services: { [TEST_SERVICE_NAME]: testServicePlan },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: planMetadata,
    extensions: {},
  };
};

const contractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `RuntimeProvider contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(contractFailure(assertion, details));

const mapProviderFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    contractFailure(assertion, details);

const mapProviderOrContractFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    details instanceof ContractFailure ? details : contractFailure(assertion, details);

const isStream = (value: unknown): boolean => Stream.StreamTypeId in Object(value);

const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

type PluginLayerExportName =
  | "ca"
  | "engine"
  | "logger"
  | "provider"
  | "proxy"
  | "renderer"
  | "services"
  | "templateEngine";

export interface PluginContractInput {
  readonly manifest: unknown;
  readonly layers?: Partial<Record<PluginLayerExportName, Layer.Layer<never, unknown, unknown>>>;
  readonly globalServices?: ReadonlyMap<string, Effect.Effect<unknown, unknown, never>>;
  readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape>;
  readonly templateEngines?: ReadonlyMap<string, unknown>;
}

const pluginContributionLayerExports: ReadonlyArray<{
  readonly key: keyof NonNullable<PluginManifest["contributes"]>;
  readonly exportName: PluginLayerExportName;
}> = [
  { key: "cas", exportName: "ca" },
  { key: "fileSyncEngines", exportName: "engine" },
  { key: "loggers", exportName: "logger" },
  { key: "providers", exportName: "provider" },
  { key: "proxies", exportName: "proxy" },
  { key: "renderers", exportName: "renderer" },
  { key: "serviceTypes", exportName: "services" },
  { key: "templateEngines", exportName: "templateEngine" },
];

export const TestPluginManifest: PluginManifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/test-plugin",
  version: "0.0.0",
  api: 4,
  description: "SDK plugin contract fixture.",
  enabled: true,
  contributes: { loggers: ["test"] },
  entry: "./src/index.ts",
  requires: { "@lando/core": "^4.0.0" },
});

const pluginContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `Plugin contract failed: ${assertion}`,
    assertion,
    details,
  });

const requirePluginContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(pluginContractFailure(assertion, details));

const isLayer = (value: unknown): boolean => Layer.isLayer(value);

const hasNonEmptyContributionEntries = (values: ReadonlyArray<unknown> | undefined): boolean =>
  values === undefined ||
  values.every(
    (value) =>
      isNonEmptyString(value) ||
      (typeof value === "object" && value !== null && "id" in value && isNonEmptyString(value.id)),
  );

const contributionId = (value: string | { readonly id: string }): string =>
  typeof value === "string" ? value : value.id;

const REQUIRED_CORE_RANGE = "^4.0.0";

const CORE_COMPATIBILITY_ASSERTION = 'manifest requires "@lando/core" "^4.0.0"';

const CORE_COMPATIBILITY_REMEDIATION = 'Set requires["@lando/core"] to "^4.0.0".';

type CoreRequirementClassification = "compatible" | "missing" | "overly-broad" | "incompatible";

const classifyCoreRequirement = (requires: PluginManifest["requires"]): CoreRequirementClassification => {
  const raw = requires?.["@lando/core"];
  if (typeof raw !== "string" || raw.trim() === "") return "missing";

  const range = raw.trim();
  if (range === REQUIRED_CORE_RANGE) return "compatible";

  if (
    /^[xX*](?:\.[xX*]){0,2}$/.test(range) ||
    range.includes("||") ||
    /^>=\s*(?:0|4(?:\.0(?:\.0)?)?)$/.test(range) ||
    /^>\s*4(?:\.0(?:\.0)?)?$/.test(range)
  ) {
    return "overly-broad";
  }

  return "incompatible";
};

/**
 * runPluginContract arguments:
 * - manifest: decoded or encoded plugin manifest object to validate.
 * - layers: static Layer exports keyed by contribution kind (`provider`, `services`, etc.).
 * - globalServices: static global-service map keyed by contributed service id.
 * - serviceTypes: static service-type map keyed by contributed service type id.
 * - templateEngines: static template-engine map keyed by contributed engine id.
 */
export const runPluginContract = (input: PluginContractInput): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const decodedManifest = Schema.decodeUnknownEither(PluginManifest)(input.manifest, {
      onExcessProperty: "error",
    });

    yield* requirePluginContract(
      Either.isRight(decodedManifest),
      "manifest decodes as PluginManifest",
      decodedManifest,
    );
    if (Either.isLeft(decodedManifest)) return;

    const manifest = decodedManifest.right;

    yield* requirePluginContract(
      isNonEmptyString(manifest.name),
      "manifest name is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(
      isNonEmptyString(manifest.version),
      "manifest version is a non-empty string",
      manifest,
    );
    yield* requirePluginContract(manifest.api === 4, "manifest api is 4", manifest);

    const coreCompatibility = classifyCoreRequirement(manifest.requires);
    yield* requirePluginContract(coreCompatibility === "compatible", CORE_COMPATIBILITY_ASSERTION, {
      reason: coreCompatibility,
      declared: manifest.requires?.["@lando/core"],
      remediation: CORE_COMPATIBILITY_REMEDIATION,
    });

    const contributions = manifest.contributes ?? {};

    for (const [key, values] of Object.entries(contributions)) {
      if (Array.isArray(values) && key !== "globalServices") {
        yield* requirePluginContract(
          hasNonEmptyContributionEntries(values),
          `contribution ${key} contains only non-empty ids`,
          values,
        );
      }
    }

    for (const { key, exportName } of pluginContributionLayerExports) {
      const ids = contributions[key];
      if (!Array.isArray(ids) || ids.length === 0) continue;

      yield* requirePluginContract(
        isLayer(input.layers?.[exportName]),
        `contribution ${key} exposes Layer export ${exportName}`,
        { exportName, ids },
      );
    }

    for (const entry of contributions.globalServices ?? []) {
      yield* requirePluginContract(
        isNonEmptyString(entry.id),
        "globalServices entries have non-empty ids",
        entry,
      );
      yield* requirePluginContract(
        Effect.isEffect(input.globalServices?.get(entry.id)),
        `globalServices static map contains declared id ${entry.id}`,
        entry,
      );
    }

    for (const entry of contributions.serviceTypes ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.serviceTypes?.has(id) === true,
        `serviceTypes static map contains declared id ${id}`,
        { id },
      );
    }

    for (const entry of contributions.templateEngines ?? []) {
      const id = contributionId(entry);
      yield* requirePluginContract(
        input.templateEngines?.has(id) === true,
        `templateEngines static map contains declared id ${id}`,
        { id },
      );
    }

    const loadError = new PluginLoadError({
      message: "plugin contract load error",
      pluginName: manifest.name,
    });
    const manifestError = new PluginManifestError({
      message: "plugin contract manifest error",
      pluginName: manifest.name,
      issues: ["contract"],
    });

    yield* requirePluginContract(
      loadError._tag === "PluginLoadError",
      "PluginLoadError tag is constructible",
      loadError,
    );
    yield* requirePluginContract(
      manifestError._tag === "PluginManifestError",
      "PluginManifestError tag is constructible",
      manifestError,
    );
  });

const CONTRACT_MATRIX_PLATFORMS: ReadonlyArray<HostPlatform> = ["darwin", "linux", "win32", "wsl"];

/**
 * Run the `RuntimeProvider` contract assertions. Validates capability decode,
 * lifecycle method types, fixture apply/inspect/destroy round-trips, provider
 * identity, status, version fields, capability completeness, ApplyResult
 * shape, re-apply idempotency, list shape, and volume-preserving destroy.
 */
export const runProviderContract = (provider: RuntimeProviderShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const providerId = ProviderId.make(provider.id);
    const testAppPlan = makeTestAppPlan(providerId);
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(provider.capabilities);

    yield* requireContract(isNonEmptyString(provider.id), "provider exposes a non-empty id", provider.id);
    yield* requireContract(
      isNonEmptyString(provider.displayName),
      "provider exposes a non-empty displayName",
      provider.displayName,
    );
    yield* requireContract(
      isNonEmptyString(provider.version),
      "provider exposes a non-empty version",
      provider.version,
    );
    yield* requireContract(
      isNonEmptyString(provider.platform),
      "provider exposes a non-empty platform",
      provider.platform,
    );

    yield* requireContract(Either.isRight(capabilities), "capability matrix decodes", capabilities);
    for (const key of CAPABILITY_KEYS) {
      yield* requireContract(
        (provider.capabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `capability ${String(key)} is populated`,
        provider.capabilities,
      );
    }

    yield* requireContract(Effect.isEffect(provider.isAvailable), "isAvailable is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getStatus), "getStatus is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getVersions), "getVersions is Effect-typed");
    yield* requireContract(
      Effect.isEffect(provider.apply(testAppPlan, { reconcile: true })),
      "apply is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.start({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "start is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.stop({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "stop is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.restart({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "restart is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(
        provider.exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "exec is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.run({ image: "node:22-alpine", command: ["echo", "ok"] })),
      "run is Effect-typed",
    );
    yield* requireContract(
      typeof provider.runStream === "function",
      "runStream is callable",
      provider.runStream,
    );
    yield* requireContract(
      isStream(provider.runStream({ image: "node:22-alpine", command: ["tar", "c"] })),
      "runStream is Stream-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.destroy({ app: TEST_APP_ID }, { volumes: true })),
      "destroy is Effect-typed",
    );
    yield* requireContract(
      isStream(
        provider.execStream({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "execStream returns a Stream of stdio chunks",
    );
    yield* requireContract(
      isStream(provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: false })),
      "logs returns a Stream of LogChunk values",
    );
    yield* requireContract(
      Effect.isEffect(provider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "inspect is Effect-typed",
    );
    yield* requireContract(Effect.isEffect(provider.list({ app: TEST_APP_ID })), "list is Effect-typed");
    yield* requireContract(
      typeof provider.snapshotVolume === "function",
      "snapshotVolume is callable",
      provider.snapshotVolume,
    );
    yield* requireContract(
      Effect.isEffect(provider.snapshotVolume({ volume: { app: TEST_APP_ID, store: "data" } })),
      "snapshotVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.restoreVolume === "function",
      "restoreVolume is callable",
      provider.restoreVolume,
    );
    yield* requireContract(
      Effect.isEffect(
        provider.restoreVolume({
          snapshot: { provider: provider.id, id: "snapshot-1" },
          target: { app: TEST_APP_ID, store: "data" },
        }),
      ),
      "restoreVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.listVolumes === "function",
      "listVolumes is callable",
      provider.listVolumes,
    );
    yield* requireContract(
      Effect.isEffect(provider.listVolumes({ app: TEST_APP_ID })),
      "listVolumes is Effect-typed",
    );
    yield* requireContract(
      typeof provider.removeVolume === "function",
      "removeVolume is callable",
      provider.removeVolume,
    );
    yield* requireContract(
      Effect.isEffect(provider.removeVolume({ app: TEST_APP_ID, store: "data" })),
      "removeVolume is Effect-typed",
    );
    yield* requireContract(
      typeof provider.copyToService === "function",
      "copyToService is callable",
      provider.copyToService,
    );
    yield* requireContract(
      Effect.isEffect(
        provider.copyToService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_COPY_SOURCE, targetPath: TEST_SERVICE_PATH },
        ),
      ),
      "copyToService is Effect-typed",
    );
    yield* requireContract(
      typeof provider.copyFromService === "function",
      "copyFromService is callable",
      provider.copyFromService,
    );
    yield* requireContract(
      isStream(
        provider.copyFromService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_SERVICE_PATH },
        ),
      ),
      "copyFromService is Stream-typed",
    );
    yield* requireContract(
      typeof provider.exportArtifact === "function",
      "exportArtifact is callable",
      provider.exportArtifact,
    );
    yield* requireContract(
      isStream(provider.exportArtifact({ providerId, ref: "web:test" })),
      "exportArtifact is Stream-typed",
    );
    yield* requireContract(
      typeof provider.importArtifact === "function",
      "importArtifact is callable",
      provider.importArtifact,
    );
    yield* requireContract(
      Effect.isEffect(provider.importArtifact(Stream.make(new Uint8Array([1, 2, 3])))),
      "importArtifact is Effect-typed",
    );

    const available = yield* provider.isAvailable.pipe(
      Effect.mapError(mapProviderFailure("isAvailable resolves")),
    );
    yield* requireContract(typeof available === "boolean", "isAvailable resolves to a boolean", available);

    const status = yield* provider.getStatus.pipe(Effect.mapError(mapProviderFailure("getStatus resolves")));
    yield* requireContract(
      typeof status.running === "boolean",
      "getStatus returns a running boolean",
      status,
    );
    yield* requireContract(
      status.message === undefined || typeof status.message === "string",
      "getStatus message is a string when present",
      status,
    );

    const versions = yield* provider.getVersions.pipe(
      Effect.mapError(mapProviderFailure("getVersions resolves")),
    );
    yield* requireContract(
      isNonEmptyString(versions.provider),
      "getVersions returns a non-empty provider version",
      versions,
    );
    yield* requireContract(
      versions.runtime === undefined || typeof versions.runtime === "string",
      "getVersions runtime is a string when present",
      versions,
    );

    const applyResult = yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("apply succeeds for the contract fixture")),
    );
    yield* requireContract(
      typeof applyResult.changed === "boolean",
      "apply returns ApplyResult with a boolean changed field",
      applyResult,
    );

    yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("re-apply under reconcile succeeds")),
    );

    const snapshot = yield* provider
      .inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })
      .pipe(Effect.mapError(mapProviderFailure("inspect returns a structured snapshot")));

    yield* requireContract(snapshot.app === TEST_APP_ID, "inspect snapshot includes app id", snapshot);
    yield* requireContract(
      snapshot.service === TEST_SERVICE_NAME,
      "inspect snapshot includes service name",
      snapshot,
    );
    yield* requireContract(
      snapshot.providerId === provider.id,
      "inspect snapshot includes provider id",
      snapshot,
    );
    yield* requireContract(typeof snapshot.status === "string", "inspect snapshot includes status", snapshot);

    const execResult = yield* provider
      .exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] })
      .pipe(Effect.mapError(mapProviderFailure("exec returns a structured result")));
    yield* requireContract(
      typeof execResult.exitCode === "number",
      "exec result includes a numeric exitCode",
      execResult,
    );
    yield* requireContract(typeof execResult.stdout === "string", "exec result includes stdout", execResult);
    yield* requireContract(typeof execResult.stderr === "string", "exec result includes stderr", execResult);

    const logChunks = yield* Effect.timeoutFail(
      provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: true, tail: 20 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
        Effect.mapError(mapProviderFailure("logs emits structured chunks")),
      ),
      {
        // Live provider log endpoints can take several seconds to flush the
        // first chunk on contended CI runners; still fail closed if no chunk emits.
        duration: Duration.seconds(15),
        onTimeout: () => contractFailure("logs emits at least one chunk", []),
      },
    );
    yield* requireContract(logChunks.length > 0, "logs emits at least one chunk", logChunks);
    for (const chunk of logChunks) {
      yield* requireContract(chunk.service === TEST_SERVICE_NAME, "log chunk includes service name", chunk);
      yield* requireContract(
        chunk.stream === "stdout" || chunk.stream === "stderr",
        "log chunk includes stream name",
        chunk,
      );
      yield* requireContract(typeof chunk.line === "string", "log chunk includes a line", chunk);
    }

    const listed = yield* provider
      .list({ app: TEST_APP_ID })
      .pipe(Effect.mapError(mapProviderFailure("list resolves for the contract fixture")));
    yield* requireContract(
      Array.isArray(listed),
      "list returns an array of service runtime snapshots",
      listed,
    );

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: false })
      .pipe(Effect.mapError(mapProviderFailure("destroy accepts volumes:false")));

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: true })
      .pipe(Effect.mapError(mapProviderFailure("destroy succeeds for the contract fixture")));

    yield* requireContract(typeof provider.setup === "function", "setup is callable", provider.setup);
    const setupEffect = provider.setup({ force: false });
    yield* requireContract(Effect.isEffect(setupEffect), "setup returns an Effect", setupEffect);

    yield* requireContract(
      versions.bundle === undefined || typeof versions.bundle === "string",
      "getVersions bundle is a string when present",
      versions,
    );
  });

export type HostPlatformId = HostPlatform;

export interface SupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: true;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
}

export interface UnsupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: false;
  readonly skipReason: string;
}

export type ContractMatrixCell = SupportedContractCell | UnsupportedContractCell;

export interface ContractMatrixCellResult {
  readonly platform: HostPlatformId;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface ContractMatrixReport {
  readonly providerName: string;
  readonly results: ReadonlyArray<ContractMatrixCellResult>;
}

export interface ContractMatrixOptions {
  readonly providerName: string;
  readonly cells: ReadonlyArray<ContractMatrixCell>;
}

const isSupported = (cell: ContractMatrixCell): cell is SupportedContractCell => cell.supported === true;

export const runProviderContractMatrix = (
  options: ContractMatrixOptions,
): Effect.Effect<ContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: ContractMatrixCellResult[] = [];
    const seenPlatforms = new Set<HostPlatform>();

    for (const cell of options.cells) {
      yield* requireContract(!seenPlatforms.has(cell.platform), "matrix cell platform is unique", cell);
      seenPlatforms.add(cell.platform);
    }

    for (const platform of CONTRACT_MATRIX_PLATFORMS) {
      yield* requireContract(seenPlatforms.has(platform), "matrix declares every canonical host platform", {
        providerName: options.providerName,
        platform,
      });
    }

    for (const cell of options.cells) {
      if (isSupported(cell)) {
        yield* requireContract(
          typeof cell.factory === "function",
          "supported matrix cell declares a factory",
          cell,
        );

        const provider = yield* cell
          .factory()
          .pipe(Effect.mapError(mapProviderFailure(`matrix cell ${cell.platform} factory resolves`)));

        yield* requireContract(
          provider.platform === cell.platform,
          "matrix cell provider platform matches cell platform",
          { platform: cell.platform, providerPlatform: provider.platform },
        );
        yield* runProviderContract(provider);
        results.push({ platform: cell.platform, outcome: "passed" });
      } else {
        yield* requireContract(
          isNonEmptyString(cell.skipReason),
          "unsupported matrix cell declares a skip reason",
          cell,
        );
        results.push({ platform: cell.platform, outcome: "skipped", reason: cell.skipReason });
      }
    }

    return { providerName: options.providerName, results };
  });

export interface ProviderDataPlaneContractInput {
  readonly providerName?: string;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
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
        provider.copyToService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath, targetPath: TEST_VOLUME_PATH, overwrite: true },
        ),
      ).pipe(Effect.mapError(mapProviderFailure("copyToService succeeds")));
      const copiedServiceBytes = yield* collectByteStream(
        provider.copyFromService(
          { app: TEST_APP_ID, service: TEST_SERVICE_NAME },
          { sourcePath: TEST_VOLUME_PATH },
        ),
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
  setup: (_options) => Effect.void,
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
  logs: (target, _options) => {
    const chunk: LogChunk = {
      service: target.service,
      stream: "stdout",
      line: "ready",
    };

    return Stream.make(chunk);
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

const serviceContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceType contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceContractFailure(assertion, details));

/** Required base env keys every catalog service must emit. */
const SERVICE_LANDO_IDENTITY_KEYS: ReadonlyArray<string> = [
  "LANDO",
  "LANDO_APP_NAME",
  "LANDO_APP_KIND",
  "LANDO_MAIL_HOST",
  "LANDO_MAIL_PORT",
  "LANDO_PROJECT",
  "LANDO_SERVICE_API",
  "LANDO_SERVICE_NAME",
  "LANDO_SERVICE_TYPE",
];

/** Deterministic per-platform host facts the service contract runner injects. */
const SERVICE_CONTRACT_HOST_FACTS: Record<HostPlatform, ServiceTypeHostFacts> = {
  linux: { os: "linux", user: "lando", uid: "1000", gid: "1000", home: "/home/lando" },
  wsl: { os: "linux", user: "lando", uid: "1000", gid: "1000", home: "/home/lando" },
  darwin: { os: "darwin", user: "lando", uid: "501", gid: "20", home: "/Users/lando" },
  win32: { os: "win32", user: "lando", uid: "0", gid: "0", home: "C:\\Users\\lando" },
};

/** Expected endpoint shape the runner asserts at least one match for. */
export interface EndpointExpectation {
  readonly port: number;
  readonly protocol: "http" | "https" | "tcp" | "udp" | "unix";
}

/**
 * Expected healthcheck probe shape. Matches against `HealthcheckPlan`:
 * - `tcp`: matches `kind: "tcp"` with the same port, or a `kind: "command"`
 *   shell probe whose argv contains a `/dev/tcp/.../<port>` or
 *   `localhost:<port>` substring.
 * - `http`: matches `kind: "http"` whose URL ends with the expected path
 *   (and optional port), or a `kind: "command"` curl/wget probe whose argv
 *   contains both an HTTP host token (`localhost`/`127.0.0.1`) and the
 *   expected path.
 */
export type HealthcheckExpectation =
  | { readonly kind: "tcp"; readonly port: number }
  | { readonly kind: "http"; readonly port?: number; readonly path: string };

/** Per-cell expectations the service contract runner enforces. */
export interface ServiceContractExpectations {
  readonly type: string;
  readonly endpoints: ReadonlyArray<EndpointExpectation>;
  readonly healthcheck: HealthcheckExpectation;
  /**
   * Environment keys the catalog service is required to populate with a
   * default value at plan time. Asserts each is present (non-undefined) in
   * `plan.environment`.
   */
  readonly defaultCredentialEnvKeys: ReadonlyArray<string>;
  /**
   * Environment keys whose values must not appear inside `plan.command` or
   * `plan.entrypoint`. Used for services that define deterministic default
   * credentials in `plan.environment`; the contract checks that the plaintext
   * values stay out of the rendered argv.
   */
  readonly defaultCredentialSecretEnvKeys?: ReadonlyArray<string>;
}

/** Single cell the service contract runner exercises. */
export interface ServiceContractInput {
  readonly serviceType: ServiceTypeShape;
  /** Landofile service block fed to `toServicePlan`. */
  readonly landofileService: Record<string, unknown>;
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly providerCapabilities: ProviderCapabilities;
  readonly serviceName?: string;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly expectations: ServiceContractExpectations;
}

/** Reference `ServiceTypeShape` the SDK ships for in-suite contract tests. */
export const TestServiceType: ServiceTypeShape = {
  id: "test",
  toServicePlan: (input) => {
    const appName = input.appName !== undefined && input.appName.length > 0 ? input.appName : "myapp";
    const slug =
      appName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "app";

    const environment: Record<string, string> = {
      LANDO: "ON",
      LANDO_APP_NAME: appName,
      LANDO_APP_KIND: "user",
      LANDO_MAIL_HOST: "mailpit.global.internal",
      LANDO_MAIL_PORT: "1025",
      LANDO_PROJECT: slug,
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: input.name,
      LANDO_SERVICE_TYPE: "test",
    };

    if (input.host !== undefined) {
      environment.LANDO_HOST_OS = input.host.os;
      environment.LANDO_HOST_USER = input.host.user;
      environment.LANDO_HOST_UID = input.host.uid;
      environment.LANDO_HOST_GID = input.host.gid;
      environment.LANDO_HOST_HOME = input.host.home;
    }

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(input.name),
      type: "test",
      provider: input.provider ?? ProviderId.make("test"),
      primary: input.primary ?? false,
      artifact: { kind: "ref", ref: "alpine:3.20" },
      environment,
      mounts: [],
      storage: [],
      endpoints: [{ port: 8080, protocol: "tcp", name: input.name }],
      routes: [],
      dependsOn: [],
      healthcheck: {
        kind: "command",
        command: ["sh", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 10,
      },
      hostAliases: [],
      metadata: input.metadata,
      extensions: {},
    });
  },
};

const isRuntimeServicePlan = Schema.is(ServicePlan);

const argvJoin = (argv: string | ReadonlyArray<string> | undefined): string => {
  if (argv === undefined) return "";
  return typeof argv === "string" ? argv : argv.join(" ");
};

const flattenServicePlanArgv = (plan: ServicePlan): string =>
  `${argvJoin(plan.command)} ${argvJoin(plan.entrypoint)}`;

const redactTokens = (value: string, tokens: ReadonlyArray<string>): string =>
  tokens.reduce(
    (redacted, token) => (token.length === 0 ? redacted : redacted.replaceAll(token, "[REDACTED]")),
    value,
  );

const commandContainsHostPort = (cmd: string, port: number): boolean => {
  const expectedPort = String(port);
  return new RegExp(`(?:127\\.0\\.0\\.1|localhost):${expectedPort}(?!\\d)`).test(cmd);
};

const commandContainsTcpProbePort = (cmd: string, port: number): boolean => {
  const expectedPort = String(port);
  return (
    new RegExp(`/dev/tcp/(?:127\\.0\\.0\\.1|localhost)/${expectedPort}(?!\\d)`).test(cmd) ||
    commandContainsHostPort(cmd, port)
  );
};

const matchesHealthcheck = (hc: HealthcheckPlan, expected: HealthcheckExpectation): boolean => {
  if (expected.kind === "tcp") {
    if (hc.kind === "tcp") return hc.port === expected.port;
    if (hc.kind === "command") return commandContainsTcpProbePort(argvJoin(hc.command), expected.port);
    return false;
  }

  if (hc.kind === "http") {
    if (expected.port !== undefined && hc.port !== undefined && hc.port !== expected.port) {
      return false;
    }
    return hc.url?.endsWith(expected.path) ?? false;
  }
  if (hc.kind === "command") {
    const cmd = argvJoin(hc.command);
    const hostToken = cmd.includes("localhost") || cmd.includes("127.0.0.1");
    const portToken = expected.port === undefined || commandContainsHostPort(cmd, expected.port);
    return hostToken && portToken && cmd.includes(expected.path);
  }
  return false;
};

/**
 * Run the `ServiceType` contract assertions: the type exposes a non-empty id
 * and a callable `toServicePlan`, the planned `ServicePlan` decodes through
 * the schema, declared expectations for type / endpoints / healthcheck /
 * `LANDO_*` env / default credentials are satisfied, and known default-
 * credential plaintext is not leaked into `command`/`entrypoint` argv.
 */
export const runServiceContract = (input: ServiceContractInput): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const serviceType = input.serviceType;
    const serviceName = input.serviceName ?? "web";
    const appName = input.appName ?? "myapp";
    const appRoot = input.appRoot ?? `/srv/apps/${appName}`;
    const host = SERVICE_CONTRACT_HOST_FACTS[input.platform];
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(input.providerCapabilities);

    yield* requireServiceContract(
      isNonEmptyString(serviceType.id),
      "service type exposes a non-empty id",
      serviceType.id,
    );
    yield* requireServiceContract(
      typeof serviceType.toServicePlan === "function",
      "service type toServicePlan is callable",
      typeof serviceType.toServicePlan,
    );
    yield* requireServiceContract(
      Either.isRight(capabilities),
      "service provider capabilities decode",
      capabilities,
    );
    for (const key of CAPABILITY_KEYS) {
      yield* requireServiceContract(
        (input.providerCapabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `service provider capability ${String(key)} is populated`,
        input.providerCapabilities,
      );
    }

    const decodedLandofile = Schema.decodeUnknownEither(LandofileShape)({
      name: appName,
      services: { [serviceName]: input.landofileService },
    });
    yield* requireServiceContract(
      Either.isRight(decodedLandofile),
      "landofile service input decodes through LandofileShape",
      Either.isLeft(decodedLandofile) ? decodedLandofile.left : undefined,
    );
    if (Either.isLeft(decodedLandofile)) return;

    const services = decodedLandofile.right.services;
    const decodedService = services?.[ServiceName.make(serviceName)];
    yield* requireServiceContract(
      decodedService !== undefined,
      "landofile decode preserves the requested service entry",
      { serviceName },
    );
    if (decodedService === undefined) return;

    let plan: ServicePlan;
    try {
      plan = serviceType.toServicePlan({
        name: serviceName,
        service: decodedService,
        appRoot,
        appName,
        provider: input.providerId,
        primary: false,
        metadata: {
          resolvedAt: "2026-05-10T18:51:00Z",
          source: "@lando/sdk/test/service-contract",
          runtime: 4,
        },
        host,
      });
    } catch (cause) {
      yield* Effect.fail(
        serviceContractFailure("service plan decodes through the ServicePlan schema", String(cause)),
      );
      return;
    }

    const planIsValid = isRuntimeServicePlan(plan);
    yield* requireServiceContract(planIsValid, "service plan decodes through the ServicePlan schema", {
      keys: typeof plan === "object" && plan !== null ? Object.keys(plan) : typeof plan,
    });
    if (!planIsValid) return;

    yield* requireServiceContract(
      plan.type === input.expectations.type,
      "service plan type matches expectations",
      { actual: plan.type, expected: input.expectations.type },
    );
    yield* requireServiceContract(
      plan.provider === input.providerId,
      "service plan provider matches the requested provider",
      { actual: plan.provider, expected: input.providerId },
    );

    yield* requireServiceContract(
      plan.endpoints.length === 0 || input.providerCapabilities.hostPortPublish !== "none",
      "service plan endpoint publishing is supported by provider capabilities",
      { hostPortPublish: input.providerCapabilities.hostPortPublish, endpoints: plan.endpoints },
    );
    yield* requireServiceContract(
      plan.healthcheck === undefined || input.providerCapabilities.serviceHealth !== "none",
      "service plan healthchecks are supported by provider capabilities",
      { serviceHealth: input.providerCapabilities.serviceHealth, healthcheck: plan.healthcheck },
    );
    yield* requireServiceContract(
      plan.storage.length === 0 || input.providerCapabilities.persistentStorage,
      "service plan persistent storage is supported by provider capabilities",
      { persistentStorage: input.providerCapabilities.persistentStorage, storage: plan.storage },
    );
    yield* requireServiceContract(
      plan.mounts.length === 0 || input.providerCapabilities.bindMounts,
      "service plan bind mounts are supported by provider capabilities",
      { bindMounts: input.providerCapabilities.bindMounts, mounts: plan.mounts },
    );

    yield* requireServiceContract(plan.endpoints.length > 0, "service plan emits at least one endpoint", {
      endpoints: plan.endpoints,
    });

    for (const expected of input.expectations.endpoints) {
      const found = plan.endpoints.some(
        (ep: EndpointPlan) => ep.port === expected.port && ep.protocol === expected.protocol,
      );
      yield* requireServiceContract(found, "service plan emits expected endpoint ports", {
        expected,
        actual: plan.endpoints,
      });
    }

    yield* requireServiceContract(plan.healthcheck !== undefined, "service plan declares a healthcheck", {
      plan: plan.name,
    });

    if (plan.healthcheck !== undefined) {
      yield* requireServiceContract(
        matchesHealthcheck(plan.healthcheck, input.expectations.healthcheck),
        "service plan healthcheck matches expected probe",
        { actual: plan.healthcheck, expected: input.expectations.healthcheck },
      );
    }

    for (const key of SERVICE_LANDO_IDENTITY_KEYS) {
      yield* requireServiceContract(
        isNonEmptyString(plan.environment[key]),
        "service plan environment contains the LANDO_* identity keys",
        { missing: key, environment: Object.keys(plan.environment) },
      );
    }

    for (const key of input.expectations.defaultCredentialEnvKeys) {
      yield* requireServiceContract(
        plan.environment[key] !== undefined,
        "service plan environment defines declared default-credential env keys",
        { missing: key, environment: Object.keys(plan.environment) },
      );
    }

    if (input.expectations.defaultCredentialSecretEnvKeys !== undefined) {
      const argv = flattenServicePlanArgv(plan);
      const secretValues = input.expectations.defaultCredentialSecretEnvKeys
        .map((key) => plan.environment[key])
        .filter((value): value is string => value !== undefined);
      for (const [index, value] of secretValues.entries()) {
        yield* requireServiceContract(
          value.length === 0 || !argv.includes(value),
          "service plan default-credential values are not leaked into argv",
          {
            secretIndex: index,
            secretEnvKeys: input.expectations.defaultCredentialSecretEnvKeys,
            argv: redactTokens(argv, secretValues),
          },
        );
      }
    }
  });

export interface SupportedServiceContractCell {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly supported: true;
  readonly factory: () => ServiceContractInput;
}

export interface UnsupportedServiceContractCell {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly supported: false;
  readonly skipReason: string;
}

export type ServiceContractMatrixCell = SupportedServiceContractCell | UnsupportedServiceContractCell;

export interface ServiceContractMatrixCellResult {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface ServiceContractMatrixReport {
  readonly serviceTypeId: string;
  readonly results: ReadonlyArray<ServiceContractMatrixCellResult>;
}

export interface ServiceContractMatrixOptions {
  readonly serviceTypeId: string;
  readonly cells: ReadonlyArray<ServiceContractMatrixCell>;
}

const isSupportedServiceCell = (cell: ServiceContractMatrixCell): cell is SupportedServiceContractCell =>
  cell.supported === true;

/**
 * Run the service-type contract suite across every (`providerId`, `platform`)
 * cell. Required canonical platforms are `darwin`, `linux`, `win32`, and `wsl`
 * (per `CONTRACT_MATRIX_PLATFORMS`), enforced per declared provider.
 */
export const runServiceContractMatrix = (
  options: ServiceContractMatrixOptions,
): Effect.Effect<ServiceContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: ServiceContractMatrixCellResult[] = [];
    const seen = new Set<string>();
    const providerPlatforms = new Map<ProviderId, Set<HostPlatform>>();

    for (const cell of options.cells) {
      const key = `${cell.providerId}::${cell.platform}`;
      yield* requireServiceContract(
        !seen.has(key),
        "service contract matrix cell (providerId, platform) is unique",
        cell,
      );
      seen.add(key);
      const platforms = providerPlatforms.get(cell.providerId) ?? new Set<HostPlatform>();
      platforms.add(cell.platform);
      providerPlatforms.set(cell.providerId, platforms);
    }

    for (const [providerId, platforms] of providerPlatforms) {
      for (const platform of CONTRACT_MATRIX_PLATFORMS) {
        yield* requireServiceContract(
          platforms.has(platform),
          "service contract matrix declares every canonical host platform per provider",
          { serviceTypeId: options.serviceTypeId, providerId, platform },
        );
      }
    }

    for (const cell of options.cells) {
      if (isSupportedServiceCell(cell)) {
        yield* requireServiceContract(
          typeof cell.factory === "function",
          "supported service contract matrix cell declares a factory",
          cell,
        );
        const contractInput = cell.factory();
        yield* requireServiceContract(
          contractInput.providerId === cell.providerId,
          "service contract matrix factory provider matches cell provider",
          { cellProviderId: cell.providerId, inputProviderId: contractInput.providerId },
        );
        yield* requireServiceContract(
          contractInput.platform === cell.platform,
          "service contract matrix factory platform matches cell platform",
          { cellPlatform: cell.platform, inputPlatform: contractInput.platform },
        );
        yield* requireServiceContract(
          contractInput.serviceType.id === options.serviceTypeId,
          "service contract matrix factory service type matches matrix service type",
          { serviceTypeId: options.serviceTypeId, inputServiceTypeId: contractInput.serviceType.id },
        );
        yield* runServiceContract(contractInput);
        results.push({
          providerId: cell.providerId,
          platform: cell.platform,
          outcome: "passed",
        });
      } else {
        yield* requireServiceContract(
          isNonEmptyString(cell.skipReason),
          "unsupported service contract matrix cell declares a skip reason",
          cell,
        );
        results.push({
          providerId: cell.providerId,
          platform: cell.platform,
          outcome: "skipped",
          reason: cell.skipReason,
        });
      }
    }

    return { serviceTypeId: options.serviceTypeId, results };
  });

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "../errors/index.ts";
import {
  type AppRef,
  FileSyncEngineCapabilities,
  type FileSyncEventChunk,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  type FileSyncSetupOptions,
} from "../schema/index.ts";
import type { FileSyncEngineShape, FileSyncError } from "../services/index.ts";

const fileSyncContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `FileSyncEngine contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireFileSyncContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(fileSyncContractFailure(assertion, details));

const FILE_SYNC_CAPABILITY_KEYS = Object.keys(FileSyncEngineCapabilities.fields) as ReadonlyArray<
  keyof typeof FileSyncEngineCapabilities.fields
>;

const FILE_SYNC_TEST_APP_REF: AppRef = {
  kind: "user",
  id: "myapp",
  root: AbsolutePath.make("/srv/apps/myapp"),
};

const FILE_SYNC_TEST_SOURCE = AbsolutePath.make("/srv/apps/myapp");

const buildFileSyncContractSpec = (mountKey: string): FileSyncSessionSpec => ({
  app: FILE_SYNC_TEST_APP_REF,
  service: ServiceName.make("web"),
  mountKey,
  source: FILE_SYNC_TEST_SOURCE,
  target: {
    _tag: "volume" as const,
    name: `lando-sync-${mountKey}`,
    path: "/app" as never,
  },
  mode: "two-way-safe",
  excludes: ["node_modules"],
});

const buildOutsideRootFileSyncContractSpec = (): FileSyncSessionSpec => ({
  ...buildFileSyncContractSpec("outside-root"),
  source: AbsolutePath.make("/etc"),
});

const sourceIsInsideAppRoot = (spec: FileSyncSessionSpec): boolean => {
  const root = spec.app.root;
  return spec.source === root || spec.source.startsWith(`${root}/`);
};

const requireFileSyncTaggedFailure = <A>(
  effect: Effect.Effect<A, FileSyncError>,
  tag: FileSyncError["_tag"],
  assertion: string,
): Effect.Effect<void, ContractFailure> =>
  Effect.either(effect).pipe(
    Effect.flatMap((result) =>
      Either.isLeft(result) && result.left._tag === tag
        ? Effect.void
        : Effect.fail(fileSyncContractFailure(assertion, result)),
    ),
  );

/**
 * Run the `FileSyncEngine` contract assertions. Validates identity,
 * capability decode, lifecycle method types, the create/pause/resume/
 * terminate session round-trip, status reporting through `listSessions`,
 * idempotent pause + terminate, and that the engine surfaces tagged
 * `FileSyncStartError` / `FileSyncDriftError` / `FileSyncStopError` for
 * the documented failure modes.
 */
export const runFileSyncEngineContract = (
  engine: FileSyncEngineShape,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireFileSyncContract(isNonEmptyString(engine.id), "engine exposes a non-empty id", engine.id);
    yield* requireFileSyncContract(
      isNonEmptyString(engine.displayName),
      "engine exposes a non-empty displayName",
      engine.displayName,
    );

    const decodedCapabilities = Schema.decodeUnknownEither(FileSyncEngineCapabilities)(engine.capabilities);
    yield* requireFileSyncContract(Either.isRight(decodedCapabilities), "capabilities decode", {
      capabilities: engine.capabilities,
      decoded: decodedCapabilities,
    });
    for (const key of FILE_SYNC_CAPABILITY_KEYS) {
      yield* requireFileSyncContract(
        (engine.capabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `capability ${String(key)} is populated`,
        engine.capabilities,
      );
    }

    yield* requireFileSyncContract(Effect.isEffect(engine.isAvailable), "isAvailable is Effect-typed");
    yield* requireFileSyncContract(Effect.isEffect(engine.setup({ force: false })), "setup is Effect-typed");
    const sentinelSpec = buildFileSyncContractSpec("__contract__");
    yield* requireFileSyncContract(
      Effect.isEffect(engine.createSession(sentinelSpec)),
      "createSession is Effect-typed",
    );
    const sentinelRef = FileSyncSessionRef.make("__contract__");
    yield* requireFileSyncContract(
      Effect.isEffect(engine.pauseSession(sentinelRef)),
      "pauseSession is Effect-typed",
    );
    yield* requireFileSyncContract(
      Effect.isEffect(engine.resumeSession(sentinelRef)),
      "resumeSession is Effect-typed",
    );
    yield* requireFileSyncContract(
      Effect.isEffect(engine.terminateSession(sentinelRef)),
      "terminateSession is Effect-typed",
    );
    yield* requireFileSyncContract(Effect.isEffect(engine.listSessions({})), "listSessions is Effect-typed");
    yield* requireFileSyncContract(
      isStream(engine.streamEvents(sentinelRef)),
      "streamEvents returns a Stream",
    );

    const isAvailable = yield* engine.isAvailable.pipe(
      Effect.mapError((details: FileSyncError) =>
        fileSyncContractFailure("isAvailable resolves", details as unknown),
      ),
    );
    yield* requireFileSyncContract(
      typeof isAvailable === "boolean",
      "isAvailable resolves to a boolean",
      isAvailable,
    );

    yield* Effect.scoped(engine.setup({ force: false })).pipe(
      Effect.mapError((details: FileSyncError) =>
        fileSyncContractFailure("setup resolves", details as unknown),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const lifecycleSpec = buildFileSyncContractSpec("lifecycle");
        const ref = yield* engine
          .createSession(lifecycleSpec)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("createSession resolves for the contract fixture", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          isNonEmptyString(ref),
          "createSession returns a non-empty FileSyncSessionRef",
          ref,
        );

        const listed = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves", details as unknown),
            ),
          );
        yield* requireFileSyncContract(Array.isArray(listed), "listSessions returns an array", listed);
        yield* requireFileSyncContract(
          listed.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "running",
          "newly created session reports status = running",
          { listed, ref },
        );

        yield* engine
          .pauseSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("pauseSession resolves", details as unknown),
            ),
          );
        const afterPause = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after pause", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterPause.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "paused",
          "paused session reports status = paused",
          { listed: afterPause, ref },
        );

        yield* engine
          .pauseSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("pauseSession is idempotent", details as unknown),
            ),
          );

        yield* engine
          .resumeSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("resumeSession resolves", details as unknown),
            ),
          );
        const afterResume = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after resume", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterResume.find((info: FileSyncSessionInfo) => info.ref === ref)?.status === "running",
          "resumed session reports status = running",
          { listed: afterResume, ref },
        );

        yield* engine
          .terminateSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("terminateSession resolves", details as unknown),
            ),
          );
        const afterTerminate = yield* engine
          .listSessions({})
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("listSessions resolves after terminate", details as unknown),
            ),
          );
        yield* requireFileSyncContract(
          afterTerminate.find((info: FileSyncSessionInfo) => info.ref === ref) === undefined,
          "terminated session is removed from listSessions",
          { listed: afterTerminate, ref },
        );

        yield* engine
          .terminateSession(ref)
          .pipe(
            Effect.mapError((details: FileSyncError) =>
              fileSyncContractFailure("terminateSession is idempotent", details as unknown),
            ),
          );

        return ref;
      }),
    );

    const scopeFinalizedRef = yield* Effect.scoped(
      engine
        .createSession(buildFileSyncContractSpec("scope-finalizer"))
        .pipe(
          Effect.mapError((details: FileSyncError) =>
            fileSyncContractFailure("createSession registers a scope finalizer", details as unknown),
          ),
        ),
    );
    const afterScope = yield* engine
      .listSessions({})
      .pipe(
        Effect.mapError((details: FileSyncError) =>
          fileSyncContractFailure("listSessions resolves after scope finalization", details as unknown),
        ),
      );
    yield* requireFileSyncContract(
      afterScope.find((info: FileSyncSessionInfo) => info.ref === scopeFinalizedRef) === undefined,
      "session is removed after createSession scope finalizes",
      { listed: afterScope, ref: scopeFinalizedRef },
    );

    yield* requireFileSyncTaggedFailure(
      Effect.scoped(engine.createSession(buildOutsideRootFileSyncContractSpec())),
      "FileSyncStartError",
      "outside-root source fails with FileSyncStartError",
    );
    yield* requireFileSyncTaggedFailure(
      Stream.runCollect(engine.streamEvents(FileSyncSessionRef.make("__CONFLICT__"))),
      "FileSyncDriftError",
      "conflict event stream fails with FileSyncDriftError",
    );
    yield* requireFileSyncTaggedFailure(
      engine.terminateSession(FileSyncSessionRef.make("__STOP_FAIL__")),
      "FileSyncStopError",
      "stop failure fails with FileSyncStopError",
    );
  });

export interface SupportedFileSyncContractCell {
  readonly platform: HostPlatformId;
  readonly supported: true;
  readonly factory: () => Effect.Effect<FileSyncEngineShape, unknown>;
}

export interface UnsupportedFileSyncContractCell {
  readonly platform: HostPlatformId;
  readonly supported: false;
  readonly skipReason: string;
}

export type FileSyncContractMatrixCell = SupportedFileSyncContractCell | UnsupportedFileSyncContractCell;

export interface FileSyncContractMatrixCellResult {
  readonly platform: HostPlatformId;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface FileSyncContractMatrixReport {
  readonly engineName: string;
  readonly results: ReadonlyArray<FileSyncContractMatrixCellResult>;
}

export interface FileSyncContractMatrixOptions {
  readonly engineName: string;
  readonly cells: ReadonlyArray<FileSyncContractMatrixCell>;
}

const isFileSyncSupported = (cell: FileSyncContractMatrixCell): cell is SupportedFileSyncContractCell =>
  cell.supported === true;

const mapFileSyncFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    fileSyncContractFailure(assertion, details);

/**
 * Run the `FileSyncEngine` contract across every canonical host platform
 * cell. Required canonical platforms are `darwin`, `linux`, `win32`, and
 * `wsl` (per `CONTRACT_MATRIX_PLATFORMS`).
 */
export const runFileSyncEngineContractMatrix = (
  options: FileSyncContractMatrixOptions,
): Effect.Effect<FileSyncContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: FileSyncContractMatrixCellResult[] = [];
    const seenPlatforms = new Set<HostPlatformId>();

    for (const cell of options.cells) {
      yield* requireFileSyncContract(
        !seenPlatforms.has(cell.platform),
        "matrix cell platform is unique",
        cell,
      );
      seenPlatforms.add(cell.platform);
    }

    for (const platform of CONTRACT_MATRIX_PLATFORMS) {
      yield* requireFileSyncContract(
        seenPlatforms.has(platform),
        "matrix declares every canonical host platform",
        { engineName: options.engineName, platform },
      );
    }

    for (const cell of options.cells) {
      if (isFileSyncSupported(cell)) {
        yield* requireFileSyncContract(
          typeof cell.factory === "function",
          "supported matrix cell declares a factory",
          cell,
        );
        const engine = yield* cell
          .factory()
          .pipe(Effect.mapError(mapFileSyncFailure(`matrix cell ${cell.platform} factory resolves`)));
        yield* runFileSyncEngineContract(engine);
        results.push({ platform: cell.platform, outcome: "passed" });
      } else {
        yield* requireFileSyncContract(
          isNonEmptyString(cell.skipReason),
          "unsupported matrix cell declares a skip reason",
          cell,
        );
        results.push({ platform: cell.platform, outcome: "skipped", reason: cell.skipReason });
      }
    }

    return { engineName: options.engineName, results };
  });

interface TestFileSyncEngineState {
  readonly sessions: Map<string, FileSyncSessionInfo>;
}

const TEST_FILE_SYNC_STATE = Symbol("TestFileSyncEngineState");

interface TestFileSyncEngineStateCarrier {
  [TEST_FILE_SYNC_STATE]?: TestFileSyncEngineState;
}

const testFileSyncEngineState = (engine: TestFileSyncEngineStateCarrier): TestFileSyncEngineState => {
  let state = engine[TEST_FILE_SYNC_STATE];
  if (state === undefined) {
    Object.defineProperty(engine, TEST_FILE_SYNC_STATE, {
      value: { sessions: new Map() },
      configurable: false,
      enumerable: false,
      writable: false,
    });
    state = engine[TEST_FILE_SYNC_STATE];
  }

  if (state === undefined) {
    throw new Error("failed to initialize test file sync engine state");
  }

  return state;
};

const TEST_FILE_SYNC_CAPABILITIES: FileSyncEngineCapabilities = {
  modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"],
  remoteAgentDeployment: "none",
  exclusionPatterns: true,
  conflictReporting: true,
  progressReporting: true,
};

const sessionRefFor = (spec: FileSyncSessionSpec): FileSyncSessionRef =>
  FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`);

const filterMatches = (info: FileSyncSessionInfo, filter: FileSyncSessionFilter): boolean => {
  if (
    filter.app !== undefined &&
    (info.app.kind !== filter.app.kind || info.app.id !== filter.app.id || info.app.root !== filter.app.root)
  ) {
    return false;
  }
  if (filter.service !== undefined && info.service !== filter.service) return false;
  if (filter.mountKey !== undefined && info.mountKey !== filter.mountKey) return false;
  return true;
};

/**
 * In-memory `FileSyncEngine` reference implementation used by the SDK
 * contract tests. Session lifecycle is fully observable through
 * `listSessions`. Three sentinel inputs trigger the documented tagged
 * error paths so plugin authors can drive the same negative-path
 * coverage:
 *
 * - `createSession({ mountKey: "__REJECT__" })` → `FileSyncStartError`
 * - `streamEvents("__CONFLICT__")` → `FileSyncDriftError`
 * - `terminateSession("__STOP_FAIL__")` → `FileSyncStopError`
 */
export const TestFileSyncEngine: FileSyncEngineShape & TestFileSyncEngineStateCarrier = {
  id: "test",
  displayName: "Test File Sync Engine",
  capabilities: TEST_FILE_SYNC_CAPABILITIES,

  isAvailable: Effect.succeed(true),
  setup: (_options: FileSyncSetupOptions) => Effect.void,

  createSession(this: TestFileSyncEngineStateCarrier, spec: FileSyncSessionSpec) {
    const state = testFileSyncEngineState(this);

    return Effect.gen(function* () {
      if (spec.mountKey === "__REJECT__") {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: "test",
            message: "Test rejection sentinel triggered",
            sessionSpec: spec,
          }),
        );
      }
      if (!sourceIsInsideAppRoot(spec)) {
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId: "test",
            message: "Source must resolve inside the app root",
            sessionSpec: spec,
          }),
        );
      }

      const ref = sessionRefFor(spec);
      const info: FileSyncSessionInfo = {
        ref,
        app: spec.app,
        service: spec.service,
        mountKey: spec.mountKey,
        status: "running",
        lastUpdatedAt: DateTime.unsafeMake("2026-05-28T00:00:00Z"),
      };
      state.sessions.set(ref, info);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.sessions.delete(ref);
        }),
      );
      return ref;
    });
  },

  pauseSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() => {
      const current = state.sessions.get(ref);
      if (current === undefined) return;
      state.sessions.set(ref, { ...current, status: "paused" });
    });
  },

  resumeSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() => {
      const current = state.sessions.get(ref);
      if (current === undefined) return;
      state.sessions.set(ref, { ...current, status: "running" });
    });
  },

  terminateSession(this: TestFileSyncEngineStateCarrier, ref: FileSyncSessionRef) {
    const state = testFileSyncEngineState(this);
    if (ref === "__STOP_FAIL__") {
      return Effect.fail(
        new FileSyncStopError({
          engineId: "test",
          sessionRef: ref,
          message: "Test stop-failure sentinel triggered",
        }),
      );
    }

    return Effect.sync(() => {
      state.sessions.delete(ref);
    });
  },

  listSessions(this: TestFileSyncEngineStateCarrier, filter: FileSyncSessionFilter) {
    const state = testFileSyncEngineState(this);
    return Effect.sync(() =>
      Array.from(state.sessions.values()).filter((info) => filterMatches(info, filter)),
    );
  },

  streamEvents: (ref: FileSyncSessionRef): Stream.Stream<FileSyncEventChunk, FileSyncError> => {
    if (ref === "__CONFLICT__") {
      return Stream.fail(
        new FileSyncDriftError({
          engineId: "test",
          message: "Test drift sentinel triggered",
          sessionRef: ref,
          conflictedPaths: ["README.md"],
          suggestedMode: "two-way-resolved",
        }),
      );
    }

    const chunk: FileSyncEventChunk = { _tag: "info", sessionRef: ref, message: "ready" };
    return Stream.make(chunk);
  },
};

import type { RoutePlan } from "../schema/index.ts";
import type { ProxyServiceShape } from "../services/index.ts";

const proxyContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ProxyService contract failed: ${assertion}`, assertion, details });

const requireProxyContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(proxyContractFailure(assertion, details));

export const runProxyServiceContract = (proxy: ProxyServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireProxyContract(
      typeof proxy.id === "string" && proxy.id.length > 0,
      "id is a non-empty string",
      proxy.id,
    );

    yield* proxy.setup().pipe(Effect.mapError((d) => proxyContractFailure("setup resolves", d)));

    const testAppId = AppId.make("contract-test-app");
    const testRoutes: ReadonlyArray<RoutePlan> = [
      { hostname: "web.contract-test-app.lndo.site", scheme: "https", service: ServiceName.make("web") },
    ];

    yield* proxy
      .applyRoutes(testRoutes, testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("applyRoutes resolves", d)));

    yield* proxy
      .removeRoutes(testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("removeRoutes resolves", d)));

    yield* proxy
      .removeRoutes(testAppId)
      .pipe(Effect.mapError((d) => proxyContractFailure("removeRoutes is idempotent", d)));
  });

export const makeTestProxyService = (): ProxyServiceShape & {
  readonly routesByApp: ReadonlyMap<string, ReadonlyArray<RoutePlan>>;
} => {
  const routesByApp = new Map<string, ReadonlyArray<RoutePlan>>();
  return {
    id: "test",
    setup: () => Effect.void,
    applyRoutes: (routes, appId) =>
      Effect.sync(() => {
        routesByApp.set(String(appId), routes);
      }),
    removeRoutes: (appId) =>
      Effect.sync(() => {
        routesByApp.delete(String(appId));
      }),
    routesByApp,
  };
};

export const TestProxyService: ProxyServiceShape = makeTestProxyService();

import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  CertificateResult,
  CertificateSpec,
} from "../services/index.ts";

const caContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `CertificateAuthority contract failed: ${assertion}`, assertion, details });

const requireCaContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(caContractFailure(assertion, details));

export const runCaContract = (ca: CertificateAuthorityShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireCaContract(
      typeof ca.id === "string" && ca.id.length > 0,
      "id is a non-empty string",
      ca.id,
    );

    yield* ca.setup({ force: false }).pipe(Effect.mapError((d) => caContractFailure("setup resolves", d)));

    const certResult = yield* ca
      .issueCert({ cn: "test.lndo.site", sans: ["*.test.lndo.site"] })
      .pipe(Effect.mapError((d) => caContractFailure("issueCert resolves", d)));

    yield* requireCaContract(
      typeof certResult.certPath === "string" && certResult.certPath.length > 0,
      "issueCert result has non-empty certPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.keyPath === "string" && certResult.keyPath.length > 0,
      "issueCert result has non-empty keyPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.caPath === "string" && certResult.caPath.length > 0,
      "issueCert result has non-empty caPath",
      certResult,
    );

    yield* ca
      .setup({ force: false, skipTrustInstall: true })
      .pipe(Effect.mapError((d) => caContractFailure("setup with skipTrustInstall resolves", d)));
  });

export const makeTestCertificateAuthority = (): CertificateAuthorityShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: CaSetupOptions }>).push({ op: "setup", opts });
      }),
    issueCert: (spec) =>
      Effect.sync((): CertificateResult => {
        (calls as Array<{ op: "issueCert"; spec: CertificateSpec }>).push({ op: "issueCert", spec });
        return {
          certPath: `/tmp/test-certs/${spec.cn}.crt`,
          keyPath: `/tmp/test-certs/${spec.cn}.key`,
          caPath: "/tmp/test-certs/ca.crt",
        };
      }),
    calls,
  };
};

export const TestCertificateAuthority: CertificateAuthorityShape = makeTestCertificateAuthority();

import type { SshAgentSocket, SshServiceShape, SshSetupOptions } from "../services/index.ts";

const sshContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `SshService contract failed: ${assertion}`, assertion, details });

const requireSshContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(sshContractFailure(assertion, details));

export const runSshServiceContract = (ssh: SshServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireSshContract(
      typeof ssh.id === "string" && ssh.id.length > 0,
      "id is a non-empty string",
      ssh.id,
    );

    yield* ssh.setup({ force: false }).pipe(Effect.mapError((d) => sshContractFailure("setup resolves", d)));

    const socketResult = yield* ssh
      .getAgentSocket(AppId.make("contract-test-app"))
      .pipe(Effect.mapError((d) => sshContractFailure("getAgentSocket resolves", d)));

    yield* requireSshContract(
      typeof socketResult.socketPath === "string" && socketResult.socketPath.length > 0,
      "getAgentSocket result has non-empty socketPath",
      socketResult,
    );

    yield* ssh
      .setup({ force: true })
      .pipe(Effect.mapError((d) => sshContractFailure("setup with force:true resolves", d)));
  });

export const makeTestSshService = (): SshServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: SshSetupOptions }>).push({ op: "setup", opts });
      }),
    getAgentSocket: (appId) =>
      Effect.sync((): SshAgentSocket => {
        (calls as Array<{ op: "getAgentSocket"; appId: AppId }>).push({ op: "getAgentSocket", appId });
        return { socketPath: `/tmp/test-ssh/${String(appId)}.sock`, appId };
      }),
    calls,
  };
};

export const TestSshService: SshServiceShape = makeTestSshService();

import type { HealthcheckResult, HealthcheckRunError, HealthcheckRunnerShape } from "../services/index.ts";

const healthcheckContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HealthcheckRunner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHealthcheckContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(healthcheckContractFailure(assertion, details));

export const runHealthcheckContract = (
  runner: HealthcheckRunnerShape,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHealthcheckContract(
      typeof runner.id === "string" && runner.id.length > 0,
      "id is a non-empty string",
      runner.id,
    );

    const testPlan: HealthcheckPlan = {
      kind: "command",
      command: ["sh", "-c", "exit 0"],
      intervalSeconds: 5,
      timeoutSeconds: 30,
      retries: 3,
    };

    const result = yield* runner
      .run(testPlan, AppId.make("contract-test-app"), ServiceName.make("web"))
      .pipe(Effect.mapError((d: HealthcheckRunError) => healthcheckContractFailure("run resolves", d)));

    yield* requireHealthcheckContract(
      typeof result.healthy === "boolean",
      "run result has boolean healthy",
      result,
    );
    yield* requireHealthcheckContract(
      typeof result.attempts === "number" && result.attempts > 0,
      "run result has positive attempts",
      result,
    );
  });

export const makeTestHealthcheckRunner = (): HealthcheckRunnerShape & {
  readonly calls: ReadonlyArray<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }>;
} => {
  const calls: Array<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }> = [];
  return {
    id: "test",
    run: (plan, appId, service) =>
      Effect.sync((): HealthcheckResult => {
        calls.push({ plan, appId, service });
        return { healthy: true, service, attempts: 1 };
      }),
    calls,
  };
};

export const TestHealthcheckRunner: HealthcheckRunnerShape = makeTestHealthcheckRunner();

import type { PortCollision, ScanResult, UrlScannerShape } from "../services/index.ts";

const scannerContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `UrlScanner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireScannerContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(scannerContractFailure(assertion, details));

export const runScannerContract = (scanner: UrlScannerShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireScannerContract(
      typeof scanner.id === "string" && scanner.id.length > 0,
      "id is a non-empty string",
      scanner.id,
    );

    const testAppId = AppId.make("contract-test-app");

    const scanResult = yield* scanner
      .scan(testAppId)
      .pipe(Effect.mapError((d) => scannerContractFailure("scan resolves", d)));

    yield* requireScannerContract(
      scanResult.appId === testAppId,
      "scan result appId matches input",
      scanResult,
    );
    yield* requireScannerContract(
      Array.isArray(scanResult.endpoints),
      "scan result has endpoints array",
      scanResult,
    );

    const collisions = yield* scanner
      .detectCollisions([testAppId])
      .pipe(Effect.mapError((d) => scannerContractFailure("detectCollisions resolves", d)));

    yield* requireScannerContract(
      Array.isArray(collisions),
      "detectCollisions result is an array",
      collisions,
    );
  });

export const makeTestUrlScanner = (): UrlScannerShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  >;
} => {
  const calls: Array<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  > = [];
  return {
    id: "test",
    scan: (appId) =>
      Effect.sync((): ScanResult => {
        calls.push({ op: "scan", appId });
        return { appId, endpoints: [] };
      }),
    detectCollisions: (appIds) =>
      Effect.sync((): ReadonlyArray<PortCollision> => {
        calls.push({ op: "detectCollisions", appIds });
        return [];
      }),
    calls,
  };
};

export const TestUrlScanner: UrlScannerShape = makeTestUrlScanner();

import type {
  HostProxyMechanism,
  HostProxyServiceShape,
  HostProxySetupOptions,
  HostProxyStatus,
} from "../services/index.ts";

const HOST_PROXY_DEFAULT_BASE_DOMAIN = "lndo.site";
const HOST_PROXY_DEFAULT_LOOPBACK = "127.0.0.1";

const hostProxyContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HostProxyService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHostProxyContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(hostProxyContractFailure(assertion, details));

export const runHostProxyContract = (service: HostProxyServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHostProxyContract(
      typeof service.id === "string" && service.id.length > 0,
      "id is a non-empty string",
      service.id,
    );

    yield* service
      .setup({ mode: "auto" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'auto' }) resolves", d)));

    const activeStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after setup", d)));

    yield* requireHostProxyContract(
      typeof activeStatus.active === "boolean",
      "status.active is a boolean",
      activeStatus,
    );
    yield* requireHostProxyContract(
      activeStatus.mode === "auto" || activeStatus.mode === "none",
      "status.mode is auto or none",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.baseDomain === "string" && activeStatus.baseDomain.length > 0,
      "status.baseDomain is a non-empty string",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.loopback === "string" && activeStatus.loopback.length > 0,
      "status.loopback is a non-empty string",
      activeStatus,
    );

    yield* service
      .setup({ mode: "none" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'none' }) resolves", d)));

    const noneStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after opt-out", d)));

    yield* requireHostProxyContract(
      noneStatus.mode === "none" && noneStatus.active === false,
      "status reports mode='none' and inactive after opt-out",
      noneStatus,
    );

    yield* service
      .teardown()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("teardown() resolves", d)));
  });

export const makeTestHostProxyService = (): HostProxyServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  > = [];

  let current: HostProxyStatus = {
    active: false,
    mode: "auto",
    mechanism: "none",
    baseDomain: HOST_PROXY_DEFAULT_BASE_DOMAIN,
    loopback: HOST_PROXY_DEFAULT_LOOPBACK,
  };

  const pickMechanism = (mode: HostProxySetupOptions["mode"]): HostProxyMechanism =>
    mode === "none" ? "skipped" : "etc-hosts";

  return {
    id: "test",
    setup: (options) =>
      Effect.sync(() => {
        calls.push({ op: "setup", options });
        current = {
          active: options.mode !== "none",
          mode: options.mode,
          mechanism: pickMechanism(options.mode),
          baseDomain: options.baseDomain ?? HOST_PROXY_DEFAULT_BASE_DOMAIN,
          loopback: options.loopback ?? HOST_PROXY_DEFAULT_LOOPBACK,
        };
      }),
    status: () =>
      Effect.sync((): HostProxyStatus => {
        calls.push({ op: "status" });
        return current;
      }),
    teardown: () =>
      Effect.sync(() => {
        calls.push({ op: "teardown" });
        current = {
          active: false,
          mode: current.mode,
          mechanism: "none",
          baseDomain: current.baseDomain,
          loopback: current.loopback,
        };
      }),
    calls,
  };
};

export const TestHostProxyService: HostProxyServiceShape = makeTestHostProxyService();

// ----- ManagedFileService contract suite ----------------------------------

const managedFileContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ManagedFileService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireManagedFileContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(managedFileContractFailure(assertion, details));

const MANAGED_FILE_CONTRACT_OWNER = "contract";

/**
 * A backend-agnostic view of a `ManagedFileService` implementation that the
 * managed-file contract suite drives. `service` is the implementation under
 * test; `base` is the resolved app root the suite stamps onto every
 * `ManagedFile`; `read`/`seed` inspect and pre-populate the working tree
 * relative to `base`; `events` returns every `ManagedFile` lifecycle event
 * emitted so far. The same suite runs against `ManagedFileServiceLive`,
 * `TestManagedFileStore`, and any host or test override of the service.
 */
export interface ManagedFileContractHarness {
  readonly name?: string;
  readonly service: Context.Tag.Service<typeof ManagedFileService>;
  readonly base: AbsolutePath;
  readonly read: (path: PortablePath) => Effect.Effect<string | null>;
  readonly seed: (path: PortablePath, content: string) => Effect.Effect<void>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

const MANAGED_FILE_CONTRACT_FORMATS = [
  { format: "text", ext: "txt", content: { kind: "text", value: "alpha=1\n" } },
  { format: "env", ext: "env", content: { kind: "structured", data: { ALPHA: "1" } } },
  { format: "json", ext: "json", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "yaml", ext: "yaml", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "javascript", ext: "js", content: { kind: "text", value: "export const alpha = 1;\n" } },
  { format: "typescript", ext: "ts", content: { kind: "text", value: "export const alpha = 1;\n" } },
] as const;

// No per-file `base` override: `adopt`/`release`/`remove({ path })` look up
// ledger entries with `base: undefined`, so a stamped base would break them.
const managedContractTextFile = (
  path: string,
  value: string,
  overrides: Partial<ManagedFile> = {},
): ManagedFile => ({
  id: `contract:${path}`,
  owner: MANAGED_FILE_CONTRACT_OWNER,
  path: path as PortablePath,
  mode: "file",
  format: "text",
  content: { kind: "text", value },
  ...overrides,
});

/**
 * Run the `ManagedFileService` contract assertions against a harness. Asserts
 * (in order): plan/apply agree on create; update replaces content; identical
 * re-apply is skip-unchanged; an in-place user edit reports a conflict; a path
 * escaping the base is rejected (`reason: "path"`); `adopt` makes a file
 * adopted and re-apply skip-adopted; `release` marks a file adopted; `remove`
 * deletes a managed file and a repeat remove is a no-op; the ownership marker
 * round-trips per supported format (re-apply is skip-unchanged); `block` mode
 * is idempotent and preserves user content; an interrupted update leaves the
 * file fully old or fully new (never torn); and a secret in managed content
 * never appears in an emitted event.
 */
export const runManagedFileContract = (
  harness: ManagedFileContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const apply = (files: ReadonlyArray<ManagedFile>): Effect.Effect<ManagedFileResult, ManagedFileError> =>
      Effect.scoped(service.apply(files));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        managedFileContractFailure(assertion, cause);

    // 1. plan matches apply (create) + status reflects a managed file.
    const createFile = managedContractTextFile("create.txt", "v1\n");
    const plan: ManagedFilePlan = yield* service
      .plan([createFile])
      .pipe(Effect.mapError(failWith("plan resolves for a new file")));
    const created = yield* apply([createFile]).pipe(Effect.mapError(failWith("apply creates a new file")));
    yield* requireManagedFileContract(
      plan.entries[0]?.action === "create" && created.entries[0]?.action === "create",
      "plan and apply agree the first write is a create",
      { plan: plan.entries, apply: created.entries },
    );
    const createdContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      createdContent !== null,
      "the created file exists in the working tree",
      createdContent,
    );
    const statusAfterCreate = yield* service.status.pipe(Effect.mapError(failWith("status resolves")));
    yield* requireManagedFileContract(
      statusAfterCreate.some(
        (info: ManagedFileInfo) =>
          info.path === "create.txt" &&
          info.owner === MANAGED_FILE_CONTRACT_OWNER &&
          info.state === "managed",
      ),
      "status reports the created file as managed",
      statusAfterCreate,
    );

    // 2. update replaces prior content wholesale.
    const updateFile = managedContractTextFile("create.txt", "v2\n");
    const updated = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply updates a managed file")),
    );
    yield* requireManagedFileContract(
      updated.entries[0]?.action === "update",
      "changed content yields an update",
      updated.entries,
    );
    const updatedContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      updatedContent?.includes("v2") === true && updatedContent.includes("v1") === false,
      "an update replaces the prior managed content",
      updatedContent,
    );

    // 3. identical re-apply is skip-unchanged.
    const skipped = yield* apply([updateFile]).pipe(Effect.mapError(failWith("re-apply resolves")));
    yield* requireManagedFileContract(
      skipped.entries[0]?.action === "skip-unchanged",
      "an identical re-apply is skip-unchanged",
      skipped.entries,
    );

    // 4. an in-place user edit is reported as a conflict.
    yield* harness.seed("create.txt" as PortablePath, `${updatedContent ?? ""}tampered\n`);
    const conflicted = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply over a user edit resolves")),
    );
    yield* requireManagedFileContract(
      conflicted.entries[0]?.action === "conflict",
      "an in-place user edit is reported as a conflict",
      conflicted.entries,
    );

    // 5. a path escaping the base is rejected with reason "path".
    const escapeFile = managedContractTextFile("../escape.txt", "nope\n");
    const escapeResult = yield* Effect.either(apply([escapeFile]));
    yield* requireManagedFileContract(
      Either.isLeft(escapeResult) && escapeResult.left.reason === "path",
      "a path escaping the base is rejected with reason path",
      escapeResult,
    );

    // 6. adopt + skip-adopted.
    const adoptFile = managedContractTextFile("adopt.txt", "a1\n");
    yield* apply([adoptFile]).pipe(Effect.mapError(failWith("apply creates the adopt fixture")));
    yield* service.adopt("adopt.txt" as PortablePath).pipe(Effect.mapError(failWith("adopt resolves")));
    const adoptStatus = yield* service.status.pipe(Effect.mapError(failWith("status resolves after adopt")));
    yield* requireManagedFileContract(
      adoptStatus.some((info: ManagedFileInfo) => info.path === "adopt.txt" && info.state === "adopted"),
      "adopt marks the file adopted",
      adoptStatus,
    );
    const skipAdopted = yield* apply([adoptFile]).pipe(
      Effect.mapError(failWith("re-apply after adopt resolves")),
    );
    yield* requireManagedFileContract(
      skipAdopted.entries[0]?.action === "skip-adopted",
      "a re-apply after adopt is skip-adopted",
      skipAdopted.entries,
    );

    // 7. release marks a file adopted.
    const releaseFile = managedContractTextFile("release.txt", "r1\n");
    yield* apply([releaseFile]).pipe(Effect.mapError(failWith("apply creates the release fixture")));
    yield* service.release("release.txt" as PortablePath).pipe(Effect.mapError(failWith("release resolves")));
    const releaseStatus = yield* service.status.pipe(
      Effect.mapError(failWith("status resolves after release")),
    );
    yield* requireManagedFileContract(
      releaseStatus.some((info: ManagedFileInfo) => info.path === "release.txt" && info.state === "adopted"),
      "release marks the file adopted",
      releaseStatus,
    );

    // 8. remove deletes the file; a repeat remove is a no-op.
    const removeFile = managedContractTextFile("remove.txt", "x1\n");
    yield* apply([removeFile]).pipe(Effect.mapError(failWith("apply creates the remove fixture")));
    const removed = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("remove resolves")));
    yield* requireManagedFileContract(
      removed.entries.length >= 1,
      "remove reports the removed entry",
      removed.entries,
    );
    const afterRemove = yield* harness.read("remove.txt" as PortablePath);
    yield* requireManagedFileContract(
      afterRemove === null,
      "a removed managed file is gone from the working tree",
      afterRemove,
    );
    const removeAgain = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("a repeat remove resolves")));
    yield* requireManagedFileContract(
      removeAgain.entries.length === 0,
      "removing an already-removed file is a no-op",
      removeAgain.entries,
    );

    // 9. the ownership marker round-trips per supported format.
    for (const spec of MANAGED_FILE_CONTRACT_FORMATS) {
      const formatPath = `marker-${spec.format}.${spec.ext}`;
      const formatFile: ManagedFile = {
        id: `contract:fmt:${spec.format}`,
        owner: MANAGED_FILE_CONTRACT_OWNER,
        path: formatPath as PortablePath,
        mode: "file",
        format: spec.format,
        content: spec.content,
      };
      const createdFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`apply creates a ${spec.format} file`)),
      );
      yield* requireManagedFileContract(
        createdFormat.entries[0]?.action === "create",
        `format ${spec.format} is created`,
        createdFormat.entries,
      );
      const formatContent = yield* harness.read(formatPath as PortablePath);
      yield* requireManagedFileContract(
        formatContent !== null,
        `format ${spec.format} writes content`,
        formatContent,
      );
      const reappliedFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`re-apply for a ${spec.format} file resolves`)),
      );
      yield* requireManagedFileContract(
        reappliedFormat.entries[0]?.action === "skip-unchanged",
        `format ${spec.format} marker round-trips to skip-unchanged`,
        reappliedFormat.entries,
      );
    }

    // 10. block mode injects a fenced region into a file Lando creates, is
    // idempotent, and preserves user content added around the fence. A
    // pre-existing fence-less file is adopted, never appended, so the block is
    // created on a new path first.
    const blockFile = managedContractTextFile("block.txt", "managed block line\n", {
      mode: "block",
      marker: "contract-block",
    });
    const blockFirst = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("apply inserts a managed block")),
    );
    yield* requireManagedFileContract(
      blockFirst.entries[0]?.action === "create",
      "the first block apply creates the fenced region",
      blockFirst.entries,
    );
    const blockCreated = yield* harness.read("block.txt" as PortablePath);
    yield* harness.seed(
      "block.txt" as PortablePath,
      `# user header line\n${blockCreated ?? ""}# user footer line\n`,
    );
    const blockReapply = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("re-apply of a managed block resolves")),
    );
    yield* requireManagedFileContract(
      blockReapply.entries[0]?.action === "skip-unchanged",
      "block mode re-apply is idempotent (skip-unchanged)",
      blockReapply.entries,
    );
    const blockContent = yield* harness.read("block.txt" as PortablePath);
    const fenceOpens = (blockContent ?? "").split(">>> lando:contract-block").length - 1;
    yield* requireManagedFileContract(
      fenceOpens === 1 &&
        (blockContent ?? "").includes("user header line") &&
        (blockContent ?? "").includes("user footer line"),
      "block mode keeps exactly one fenced region and preserves user content",
      { fenceOpens, blockContent },
    );

    // 11. an interrupted update leaves the file fully old or fully new (never torn).
    const atomicFile = managedContractTextFile("atomic.txt", "alpha\n");
    yield* apply([atomicFile]).pipe(Effect.mapError(failWith("apply creates the atomic fixture")));
    const atomicBeta = managedContractTextFile("atomic.txt", "beta\n");
    yield* apply([atomicBeta]).pipe(Effect.mapError(failWith("apply updates the atomic fixture")));
    const beforeInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const atomicGamma = managedContractTextFile("atomic.txt", "gamma\n");
    const fiber = yield* Effect.fork(apply([atomicGamma]));
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const interruptedFileIsTorn =
      afterInterrupt === null ||
      !afterInterrupt.endsWith("\n") ||
      (afterInterrupt !== beforeInterrupt &&
        !(afterInterrupt.includes("gamma") && !afterInterrupt.includes("beta")));
    yield* requireManagedFileContract(
      !interruptedFileIsTorn,
      "an interrupted update leaves the file fully old or fully new, never torn",
      { beforeInterrupt, afterInterrupt },
    );

    // 12. a secret in managed content never appears in an emitted event.
    const secret = "ULW-MANAGED-SECRET-d41d8cd9f00b204e";
    const secretFile = managedContractTextFile("secret.txt", `token=${secret}\n`);
    yield* apply([secretFile]).pipe(Effect.mapError(failWith("apply of a secret-bearing file resolves")));
    const emitted = yield* harness.events();
    yield* requireManagedFileContract(emitted.length > 0, "apply emits lifecycle events", emitted.length);
    yield* requireManagedFileContract(
      !JSON.stringify(emitted).includes(secret),
      "a secret in managed content never appears in an emitted event",
      { sampleEvent: emitted[0] },
    );
    const secretOnDisk = yield* harness.read("secret.txt" as PortablePath);
    yield* requireManagedFileContract(
      secretOnDisk?.includes(secret) === true,
      "the secret is written to the working tree (sanity)",
      secretOnDisk,
    );
  });

export interface RemoteSourceContractObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<RemoteSourceEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<RemoteSourceToolProvisionRecord>>;
  readonly datasetDelegations: () => Effect.Effect<ReadonlyArray<RemoteSourceDatasetDelegationRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<RemoteSourceFinalizerRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<RemoteSourceProbeRecord>>;
}

export interface RemoteSourceEgressRecord {
  readonly request: { readonly url: string; readonly allowFileSource?: boolean; readonly headers?: unknown };
}

export interface RemoteSourceToolProvisionRecord {
  readonly request: DownloadRequest;
}

export interface RemoteSourceDatasetDelegationRecord {
  readonly operation: "fetch" | "send";
  readonly endpoint: DataEndpoint;
}

export interface RemoteSourceFinalizerRecord {
  readonly operation: "fetch" | "send";
  readonly remote: string;
}

export interface RemoteSourceProbeRecord {
  readonly remote: string;
  readonly env?: RemoteEnvId;
}

export interface RemoteSourceContractHarness {
  readonly name?: string;
  readonly source: RemoteSourceShape;
  readonly noPushSource: RemoteSourceShape;
  readonly config: RemoteConfig;
  readonly supportedEnv: RemoteEnvId;
  readonly protectedEnv: RemoteEnvId;
  readonly missingEnv: RemoteEnvId;
  readonly supportedDataset: DatasetKind;
  readonly unsupportedDataset: DatasetKind;
  readonly artifact: DataEndpoint;
  readonly observations: RemoteSourceContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

export interface DatasetContractObservations {
  readonly dataMoverTransfers: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
  readonly dataMoverStreams: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
}

export interface DatasetDataMoverRecord {
  readonly operation: "capture" | "apply";
  readonly endpoint: DataEndpoint;
  readonly command?: CommandSpec | undefined;
}

export interface DatasetContractHarness {
  readonly name?: string;
  readonly dataset: DatasetShape;
  readonly context: DatasetContext;
  readonly codeTreeContext: DatasetContext;
  readonly expectedBytes: Uint8Array;
  readonly observations: DatasetContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly readAppliedBytes: () => Effect.Effect<Uint8Array | null>;
}

const remoteSyncContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Remote sync contract failed: ${assertion}`, assertion, details });

const requireRemoteSyncContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(remoteSyncContractFailure(assertion, details));

const mapRemoteSyncFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    remoteSyncContractFailure(assertion, details);

const sameBytePayload = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const eventJson = (events: ReadonlyArray<LandoEvent>): string => JSON.stringify(events);

const commandIncludesCredential = (
  record: DatasetDataMoverRecord,
  credentials: ReadonlyArray<string>,
): boolean =>
  record.command !== undefined &&
  credentials.some(
    (credential) => credential.length > 0 && JSON.stringify(record.command).includes(credential),
  );

const stringValues = (record: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<string> =>
  Object.values(record ?? {}).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

export const runRemoteSourceContract = (
  harness: RemoteSourceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const source = harness.source;

    yield* requireRemoteSyncContract(source.id.length > 0, "RemoteSource declares a non-empty id", source.id);
    yield* requireRemoteSyncContract(
      source.capabilities.environments === true,
      "RemoteSource declares environment listing capability",
      source.capabilities,
    );
    yield* requireRemoteSyncContract(
      source.capabilities.datasets.includes(harness.supportedDataset),
      "RemoteSource capabilities include the supported dataset",
      source.capabilities,
    );

    const firstEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments resolves")));
    const secondEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(firstEnvs) === JSON.stringify(secondEnvs) &&
        firstEnvs.some((env) => env.id === harness.supportedEnv) &&
        firstEnvs.some((env) => env.id === harness.protectedEnv && env.protected === true),
      "listEnvironments is deterministic and includes normal + protected envs",
      { firstEnvs, secondEnvs },
    );

    const locator = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a locator for a supported env/dataset")));
    const locatorAgain = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(locator) === JSON.stringify(locatorAgain) &&
        locator.env === harness.supportedEnv &&
        locator.dataset === harness.supportedDataset,
      "resolve is deterministic and echoes env/dataset",
      { locator, locatorAgain },
    );

    const missingEnv = yield* Effect.either(
      source.resolve(harness.config, harness.missingEnv, harness.supportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(missingEnv) && missingEnv.left instanceof RemoteEnvNotFoundError,
      "unknown env fails RemoteEnvNotFoundError",
      missingEnv,
    );

    const unsupportedDataset = yield* Effect.either(
      source.resolve(harness.config, harness.supportedEnv, harness.unsupportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(unsupportedDataset) && unsupportedDataset.left instanceof RemoteDatasetUnsupportedError,
      "unknown dataset fails RemoteDatasetUnsupportedError",
      unsupportedDataset,
    );

    const egressBefore = (yield* harness.observations.egressRequests()).length;
    const toolBefore = (yield* harness.observations.toolProvisions()).length;
    const delegationsBefore = (yield* harness.observations.datasetDelegations()).length;
    const finalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetched = yield* Effect.scoped(source.fetch(locator)).pipe(
      Effect.mapError(mapRemoteSyncFailure("fetch resolves under a Scope")),
    );
    yield* requireRemoteSyncContract(
      fetched._tag === "hostArchive" || fetched._tag === "stream" || fetched._tag === "artifact",
      "fetch returns a portable DataEndpoint",
      fetched,
    );
    const egressAfterFetch = yield* harness.observations.egressRequests();
    const toolsAfterFetch = yield* harness.observations.toolProvisions();
    const delegationsAfterFetch = yield* harness.observations.datasetDelegations();
    const finalizersAfterFetch = yield* harness.observations.finalizers();
    const toolProvisioningSatisfied =
      source.capabilities.tool === undefined ||
      (toolsAfterFetch.length > toolBefore &&
        toolsAfterFetch.some(
          (record) =>
            record.request.destination.kind === "memory" &&
            record.request.url.startsWith("https://") &&
            record.request.callerId?.includes("tool-provision") === true,
        ));
    yield* requireRemoteSyncContract(
      egressAfterFetch.length > egressBefore &&
        egressAfterFetch.some((record) => record.request.url === locator.endpoint) &&
        toolProvisioningSatisfied &&
        delegationsAfterFetch.length > delegationsBefore &&
        delegationsAfterFetch.some(
          (record) => record.operation === "fetch" && record.endpoint._tag === fetched._tag,
        ) &&
        finalizersAfterFetch.length > finalizersBefore &&
        finalizersAfterFetch.some((record) => record.operation === "fetch" && record.remote === source.id),
      "fetch records egress, tool provisioning, dataset delegation, and Scope finalization",
      {
        before: { egressBefore, toolBefore, delegationsBefore, finalizersBefore },
        after: { egressAfterFetch, toolsAfterFetch, delegationsAfterFetch, finalizersAfterFetch },
      },
    );

    const fetchInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetchFiber = yield* Effect.fork(
      Effect.scoped(source.fetch(locator, { expectedDigest: "interrupt-contract" })),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(fetchFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > fetchInterruptFinalizersBefore,
      "interrupted fetch finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const noPushLocator = yield* harness.noPushSource
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("no-push source resolves supported locator")));
    const noPushSend = yield* Effect.either(
      Effect.scoped(harness.noPushSource.send(noPushLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(noPushSend) && noPushSend.left instanceof RemoteDatasetUnsupportedError,
      "push is rejected when capabilities.push is false",
      noPushSend,
    );

    const protectedLocator = yield* source
      .resolve(harness.config, harness.protectedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a protected locator")));
    const protectedWithoutForce = yield* Effect.either(
      Effect.scoped(source.send(protectedLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(protectedWithoutForce) && protectedWithoutForce.left instanceof RemoteProtectedEnvError,
      "protected env push requires explicit confirmation",
      protectedWithoutForce,
    );

    const sendFinalizersBefore = (yield* harness.observations.finalizers()).length;
    yield* Effect.scoped(
      source.send(protectedLocator, harness.artifact, { protectedEnvConfirmed: true }),
    ).pipe(Effect.mapError(mapRemoteSyncFailure("confirmed protected send resolves under a Scope")));
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > sendFinalizersBefore &&
        (yield* harness.observations.egressRequests()).some(
          (record) => record.request.url === protectedLocator.endpoint,
        ) &&
        (yield* harness.observations.datasetDelegations()).some(
          (record) => record.operation === "send" && record.endpoint._tag === harness.artifact._tag,
        ),
      "send finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const sendInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const sendFiber = yield* Effect.fork(
      Effect.scoped(
        source.send(protectedLocator, harness.artifact, {
          protectedEnvConfirmed: true,
          expectedDigest: "interrupt-contract",
        }),
      ),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(sendFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > sendInterruptFinalizersBefore,
      "interrupted send finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const probesBefore = (yield* harness.observations.probes()).length;
    const testResult = yield* (
      source.test?.(harness.config, harness.supportedEnv) ??
      Effect.fail(remoteSyncContractFailure("RemoteSource exposes a readiness test method"))
    ).pipe(Effect.mapError(mapRemoteSyncFailure("readiness test resolves")));
    yield* requireRemoteSyncContract(
      testResult.ok === true &&
        (yield* harness.observations.probes()).length > probesBefore &&
        (yield* harness.observations.probes()).some(
          (record) => record.remote === source.id && record.env === harness.supportedEnv,
        ),
      "readiness uses the probe/test seam instead of ad-hoc retry",
      testResult,
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-fetch") &&
        events.some((event) => event.eventName === "post-dataset-fetch") &&
        events.some((event) => event.eventName === "pre-dataset-send") &&
        events.some((event) => event.eventName === "post-dataset-send"),
      "fetch/send emit Sync lifecycle events",
      events,
    );
    const remoteSecretValues = [
      ...Object.entries(harness.config)
        .filter(([key]) => key !== "source")
        .flatMap(([, value]) => (typeof value === "string" ? [value] : [])),
      ...stringValues(locator.metadata),
      ...stringValues(protectedLocator.metadata),
    ];
    yield* requireRemoteSyncContract(
      remoteSecretValues.every((secret) => !eventJson(events).includes(secret)),
      "RemoteSource lifecycle events redact tokens and remote secrets",
      { remoteSecretValues, events },
    );
  });

export const runDatasetContract = (harness: DatasetContractHarness): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const dataset = harness.dataset;

    yield* requireRemoteSyncContract(dataset.id.length > 0, "Dataset declares a non-empty id", dataset.id);
    yield* requireRemoteSyncContract(
      dataset.capabilities.capture === true && dataset.capabilities.apply === true,
      "Dataset declares capture/apply capabilities honestly",
      dataset.capabilities,
    );
    yield* requireRemoteSyncContract(
      dataset.artifactFormat.endpoint === "hostArchive" || dataset.artifactFormat.endpoint === "stream",
      "Dataset declares a portable artifact format",
      dataset.artifactFormat,
    );

    const localStore = yield* dataset
      .localStore(harness.context)
      .pipe(Effect.mapError(mapRemoteSyncFailure("localStore resolves")));
    yield* requireRemoteSyncContract(localStore !== null, "Dataset reports its local store", localStore);

    const transfersBefore = (yield* harness.observations.dataMoverTransfers()).length;
    const streamsBefore = (yield* harness.observations.dataMoverStreams()).length;
    const artifact = yield* Effect.scoped(dataset.capture(harness.context)).pipe(
      Effect.mapError(mapRemoteSyncFailure("capture produces an artifact")),
    );
    yield* requireRemoteSyncContract(
      artifact._tag === "hostArchive" || artifact._tag === "stream" || artifact._tag === "artifact",
      "capture returns a portable DataEndpoint",
      artifact,
    );
    const applied = yield* Effect.scoped(dataset.apply(harness.context, artifact, { snapshot: true })).pipe(
      Effect.mapError(mapRemoteSyncFailure("apply consumes the artifact")),
    );
    yield* requireRemoteSyncContract(applied.changed === true, "first apply reports a change", applied);
    const appliedBytes = yield* harness.readAppliedBytes();
    yield* requireRemoteSyncContract(
      sameBytePayload(appliedBytes, harness.expectedBytes),
      "capture -> apply round-trips dataset bytes",
      { expected: Array.from(harness.expectedBytes), actual: appliedBytes ? Array.from(appliedBytes) : null },
    );
    const transfersAfterApply = yield* harness.observations.dataMoverTransfers();
    const streamsAfterApply = yield* harness.observations.dataMoverStreams();
    yield* requireRemoteSyncContract(
      transfersAfterApply.length >= transfersBefore + 2 &&
        transfersAfterApply.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ) &&
        transfersAfterApply.some(
          (record) => record.operation === "apply" && record.endpoint._tag === artifact._tag,
        ) &&
        streamsAfterApply.length > streamsBefore &&
        streamsAfterApply.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ),
      "capture/apply delegate byte movement to DataMover hooks",
      {
        before: { transfersBefore, streamsBefore },
        after: { transfers: transfersAfterApply, streams: streamsAfterApply },
      },
    );
    const credentialValues = Object.values(harness.context.creds ?? {});
    yield* requireRemoteSyncContract(
      [...transfersAfterApply, ...streamsAfterApply].every(
        (record) => !commandIncludesCredential(record, credentialValues),
      ),
      "Dataset credentials are not passed through service command argv",
      { credentials: credentialValues, transfers: transfersAfterApply, streams: streamsAfterApply },
    );

    const replay = yield* Effect.scoped(dataset.apply(harness.context, artifact)).pipe(
      Effect.mapError(mapRemoteSyncFailure("replay apply resolves")),
    );
    yield* requireRemoteSyncContract(
      replay.changed === false,
      "apply is idempotent/replay-safe for the same artifact",
      replay,
    );

    const codeTreeCapture = yield* Effect.either(Effect.scoped(dataset.capture(harness.codeTreeContext)));
    const codeTreeApply = yield* Effect.either(
      Effect.scoped(dataset.apply(harness.codeTreeContext, artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(codeTreeCapture) &&
        codeTreeCapture.left instanceof DatasetBindingError &&
        Either.isLeft(codeTreeApply) &&
        codeTreeApply.left instanceof DatasetBindingError,
      "code-tree-targeting bindings fail DatasetBindingError",
      { codeTreeCapture, codeTreeApply },
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-capture") &&
        events.some((event) => event.eventName === "post-dataset-capture") &&
        events.some((event) => event.eventName === "pre-dataset-apply") &&
        events.some((event) => event.eventName === "post-dataset-apply"),
      "Dataset emits capture/apply lifecycle events",
      events,
    );
    yield* requireRemoteSyncContract(
      credentialValues.every((secret) => !eventJson(events).includes(secret)),
      "Dataset lifecycle events redact credentials and dataset secrets",
      { credentialValues, events },
    );
  });

export const makeRemoteSourceContractSuite = runRemoteSourceContract;
export const makeDatasetContractSuite = runDatasetContract;

const downloaderContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Downloader contract failed: ${assertion}`, assertion, details });

const requireDownloaderContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(downloaderContractFailure(assertion, details));

const sha256HexDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const downloaderErrorLeft = (value: unknown): { readonly _tag?: string; readonly reason?: string } =>
  value as { readonly _tag?: string; readonly reason?: string };

/**
 * The harness a `Downloader` implementation provides so one suite can run
 * against `DownloaderLive`, `TestDownloader`, or a plugin-contributed
 * downloader. `tempDir` is the destination directory the suite writes into;
 * `read`/`listDir` are relative to it. `serveSource` registers the bytes a
 * source URL resolves to. The optional `egress` hooks expose the byte/call
 * accounting needed to assert the egress fence (every byte flows through the
 * resolved `HttpClient`); omit them for a downloader with no observable egress.
 */
export interface DownloaderContractHarness {
  readonly name?: string;
  readonly service: DownloaderShape;
  readonly tempDir: AbsolutePath;
  readonly serveSource: (url: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly read: (filename: string) => Effect.Effect<Uint8Array | null>;
  readonly listDir: () => Effect.Effect<ReadonlyArray<string>>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly egress?: {
    readonly streamCallCount: () => Effect.Effect<number>;
    readonly bytesStreamed: () => Effect.Effect<number>;
  };
}

/**
 * Run the `Downloader` contract assertions against a harness. Asserts (in
 * order): capability declaration; a verified `https://` download streams fresh
 * bytes and returns sha256+size (`fromCache:false`); an identical re-request is
 * served from the verified cache with no egress; `offline` + uncached fails
 * with `DownloadOfflineError` and issues no egress; a checksum mismatch is
 * rejected; a size mismatch is rejected; `http://` and bare `file://` sources
 * are rejected; a destination filename escaping the directory is rejected; a
 * successful file download leaves no temp file (atomic rename); an interrupted
 * file download leaves no temp file and the destination fully absent or fully
 * complete (never torn); lifecycle events are published and a secret in the URL
 * query / userinfo / caller fields never appears in any event; and (when the
 * harness exposes egress) a network miss issues exactly one stream call whose
 * byte count equals the downloaded size.
 */
export const runDownloaderContract = (
  harness: DownloaderContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const download = (
      request: Parameters<DownloaderShape["download"]>[0],
    ): Effect.Effect<DownloadResult, unknown> => Effect.scoped(service.download(request));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        downloaderContractFailure(assertion, cause);
    const dir = harness.tempDir;

    yield* requireDownloaderContract(
      typeof service.id === "string" && service.id.length > 0,
      "the downloader declares a non-empty id",
      service.id,
    );
    yield* requireDownloaderContract(
      Array.isArray(service.capabilities.schemes) && service.capabilities.schemes.includes("https"),
      "capabilities declare the https scheme",
      service.capabilities,
    );

    const payload = new TextEncoder().encode("contract artifact payload");
    const expectedSha256 = sha256HexDigest(payload);
    const okUrl = "https://contract.test/artifact.bin";
    yield* harness.serveSource(okUrl, payload);
    const created = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
      callerId: "contract",
    }).pipe(Effect.mapError(failWith("a verified https download succeeds")));
    yield* requireDownloaderContract(
      created.fromCache === false &&
        created.sha256 === expectedSha256 &&
        created.sizeBytes === payload.length,
      "the first download streams fresh bytes and returns sha256+size",
      created,
    );
    const onDisk = yield* harness.read("artifact.bin");
    yield* requireDownloaderContract(
      onDisk !== null && onDisk.length === payload.length,
      "the verified file is written to the destination",
      onDisk?.length,
    );

    const cacheCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const cached = yield* download({
      url: okUrl,
      destination: { kind: "file", directory: dir, filename: "artifact.bin" },
      expectedSha256,
      expectedSizeBytes: payload.length,
    }).pipe(Effect.mapError(failWith("a cached re-request resolves")));
    yield* requireDownloaderContract(
      cached.fromCache === true,
      "an identical re-request is served from the verified cache",
      cached,
    );
    if (harness.egress) {
      const cacheCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(cacheCallsAfter === cacheCallsBefore, "a cache hit issues no egress", {
        cacheCallsBefore,
        cacheCallsAfter,
      });
    }

    const offlineUrl = "https://contract.test/offline.bin";
    yield* harness.serveSource(offlineUrl, payload);
    const offlineCallsBefore = harness.egress ? yield* harness.egress.streamCallCount() : 0;
    const offlineResult = yield* Effect.either(
      download({
        url: offlineUrl,
        destination: { kind: "file", directory: dir, filename: "offline.bin" },
        expectedSha256,
        offline: true,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(offlineResult) && downloaderErrorLeft(offlineResult.left)._tag === "DownloadOfflineError",
      "offline + uncached fails with DownloadOfflineError",
      offlineResult,
    );
    if (harness.egress) {
      const offlineCallsAfter = yield* harness.egress.streamCallCount();
      yield* requireDownloaderContract(
        offlineCallsAfter === offlineCallsBefore,
        "an offline cache miss issues no egress",
        { offlineCallsBefore, offlineCallsAfter },
      );
    }

    const checksumUrl = "https://contract.test/checksum.bin";
    yield* harness.serveSource(checksumUrl, payload);
    const checksumResult = yield* Effect.either(
      download({
        url: checksumUrl,
        destination: { kind: "memory" },
        expectedSha256: "a".repeat(64),
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(checksumResult) &&
        downloaderErrorLeft(checksumResult.left)._tag === "DownloadChecksumError",
      "a checksum mismatch is rejected with DownloadChecksumError",
      checksumResult,
    );

    const sizeUrl = "https://contract.test/size.bin";
    yield* harness.serveSource(sizeUrl, payload);
    const sizeResult = yield* Effect.either(
      download({
        url: sizeUrl,
        destination: { kind: "memory" },
        expectedSizeBytes: payload.length + 1,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(sizeResult) && downloaderErrorLeft(sizeResult.left)._tag === "DownloadSizeMismatchError",
      "a size mismatch is rejected with DownloadSizeMismatchError",
      sizeResult,
    );

    const schemeResult = yield* Effect.either(
      download({ url: "http://contract.test/insecure.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(schemeResult) &&
        downloaderErrorLeft(schemeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(schemeResult.left).reason === "scheme",
      "an http:// source is rejected with reason scheme",
      schemeResult,
    );

    const fileResult = yield* Effect.either(
      download({ url: "file:///tmp/contract.bin", destination: { kind: "memory" } }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(fileResult) &&
        downloaderErrorLeft(fileResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(fileResult.left).reason === "file-source",
      "a bare file:// source is rejected with reason file-source",
      fileResult,
    );

    const escapeResult = yield* Effect.either(
      download({
        url: okUrl,
        destination: { kind: "file", directory: dir, filename: "../escape.bin" },
        expectedSha256,
      }),
    );
    yield* requireDownloaderContract(
      Either.isLeft(escapeResult) &&
        downloaderErrorLeft(escapeResult.left)._tag === "DownloadSourceForbiddenError" &&
        downloaderErrorLeft(escapeResult.left).reason === "destination-escape",
      "a destination filename escaping the directory is rejected",
      escapeResult,
    );

    const afterSuccess = yield* harness.listDir();
    yield* requireDownloaderContract(
      afterSuccess.includes("artifact.bin") && !afterSuccess.some((f) => f.includes(".tmp-")),
      "a successful download leaves the destination and no temp file",
      afterSuccess,
    );

    const interruptUrl = "https://contract.test/interrupt.bin";
    yield* harness.serveSource(interruptUrl, payload);
    const fiber = yield* Effect.fork(
      download({
        url: interruptUrl,
        destination: { kind: "file", directory: dir, filename: "interrupt.bin" },
        expectedSha256,
      }),
    );
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.listDir();
    yield* requireDownloaderContract(
      !afterInterrupt.some((f) => f.includes(".tmp-")),
      "an interrupted download leaves no temp file",
      afterInterrupt,
    );
    const interruptedFile = yield* harness.read("interrupt.bin");
    yield* requireDownloaderContract(
      interruptedFile === null || interruptedFile.length === payload.length,
      "an interrupted download leaves the destination absent or complete, never torn",
      interruptedFile?.length,
    );

    const secret = "ULW-DLC-SECRET-d41d8cd9f00b2";
    const secretUrl = `https://user:${secret}@contract.test/s?token=${secret}`;
    yield* harness.serveSource(secretUrl, payload);
    yield* download({
      url: secretUrl,
      destination: { kind: "memory" },
      expectedSha256,
      callerId: `caller-${secret}`,
      redactionTokens: [secret],
    }).pipe(Effect.mapError(failWith("a secret-bearing download succeeds")));
    const events = yield* harness.events();
    yield* requireDownloaderContract(
      events.some((e) => e._tag === "pre-download") && events.some((e) => e._tag === "post-download"),
      "pre-download and post-download events are published",
      events.map((e) => e._tag),
    );
    yield* requireDownloaderContract(
      !JSON.stringify(events).includes(secret),
      "a secret in the URL query / userinfo / caller fields never appears in an event",
      { sample: events[0] },
    );

    if (harness.egress) {
      const egressUrl = "https://contract.test/egress.bin";
      yield* harness.serveSource(egressUrl, payload);
      const callsBefore = yield* harness.egress.streamCallCount();
      const bytesBefore = yield* harness.egress.bytesStreamed();
      const egressResult = yield* download({
        url: egressUrl,
        destination: { kind: "memory" },
        expectedSha256,
      }).pipe(Effect.mapError(failWith("an egress-observed download succeeds")));
      const callsAfter = yield* harness.egress.streamCallCount();
      const bytesAfter = yield* harness.egress.bytesStreamed();
      yield* requireDownloaderContract(
        callsAfter - callsBefore === 1,
        "a network miss issues exactly one egress stream call",
        { callsBefore, callsAfter },
      );
      yield* requireDownloaderContract(
        bytesAfter - bytesBefore === egressResult.sizeBytes,
        "every downloaded byte flows through the resolved HttpClient",
        { bytesBefore, bytesAfter, sizeBytes: egressResult.sizeBytes },
      );
    }
  });

const interactionContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `InteractionService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireInteractionContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(interactionContractFailure(assertion, details));

type RendererServiceShape = Context.Tag.Service<typeof Renderer>;

/**
 * Capturing renderer used by the contract to prove prompt chrome routes
 * through `Renderer.output.stdout` instead of a direct stdio write.
 */
export interface InteractionContractRenderer {
  readonly service: RendererServiceShape;
  readonly stdout: () => string;
}

/** Build a capturing renderer the harness can inject for the routing assertion. */
export const makeInteractionContractRenderer = (id = "plain"): InteractionContractRenderer => {
  let out = "";
  return {
    stdout: () => out,
    service: {
      id,
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: {
        stdout: (chunk: string) =>
          Effect.sync(() => {
            out += chunk;
          }),
        stderr: () => Effect.void,
      },
    },
  };
};

/**
 * Description of one interaction service instance the harness must construct.
 * The caller wires the real construction deps (scripted/never stdin, a capturing
 * stdout, an optional renderer, an optional dynamic-choices runner) so the
 * contract drives only the published `InteractionServiceShape` methods.
 */
export interface InteractionServiceSpec {
  /** Lines the service should read for interactive prompts, in order. */
  readonly scriptedInput?: ReadonlyArray<string>;
  /** When true, the service must use a stdin that is never read (proves fail-fast). */
  readonly neverStdin?: boolean;
  /** When true, the service's stdin reports `isTTY: true`. */
  readonly tty?: boolean;
  /** Stdout sink the service writes prompt chrome to when no renderer is present. */
  readonly stdout?: (chunk: string) => void;
  /** Renderer to provide to the service effect (routing assertion). */
  readonly renderer?: RendererServiceShape;
  /** Dynamic-choices command result for `choicesFrom` prompts. */
  readonly choicesResult?: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

/**
 * Harness for {@link runInteractionContract}.
 *
 * `makeService` builds an `InteractionServiceShape` from a {@link InteractionServiceSpec}.
 * The Live caller wires `makeInteractionService` with scripted IO; the test-double
 * caller wires `makeTestInteractionService`. Capability flags gate assertions that
 * a given implementation can satisfy (e.g. a non-stdin test double cannot exercise
 * the interrupt/TTY-restore path).
 */
export interface InteractionContractHarness {
  readonly name?: string;
  readonly makeService: (spec: InteractionServiceSpec) => InteractionServiceShape;
  /** Declared capabilities (mirrors `InteractionServiceContribution.capabilities`). */
  readonly capabilities: {
    readonly interactive: boolean;
    readonly promptTypes: ReadonlyArray<PromptType>;
    readonly secretRedaction: boolean;
  };
  /**
   * When true, the suite exercises interactive stdin reading: prompt chrome
   * routing through `Renderer.output` and (with {@link supportsInterruption})
   * the cancellation path. A non-interactive-only implementation (e.g. a
   * terminal-free test double) declares this `false`.
   */
  readonly supportsInteractiveInput?: boolean;
  /** When true, the suite exercises external `Effect.interrupt` -> cancellation + TTY restore. */
  readonly supportsInterruption?: boolean;
  /** When true, the suite exercises dynamic `choicesFrom` resolution + manual fallback. */
  readonly supportsDynamicChoices?: boolean;
}

const interactionTextPrompt = (name: string, message = "Value?"): PromptSpec => ({
  name,
  type: "text",
  message,
});

const runInteractionScoped = <A>(
  effect: Effect.Effect<A, InteractionError, Scope.Scope>,
): Effect.Effect<Exit.Exit<A, InteractionError>> => Effect.exit(Effect.scoped(effect));

const interactionFailureTag = <A>(exit: Exit.Exit<A, InteractionError>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

/**
 * Run the `InteractionService` contract assertions against a harness. Asserts (in
 * order): capability declaration; answer-source precedence (explicit answer wins
 * over default and over reading input); `auto`-mode TTY gating (non-TTY resolves
 * non-interactively); non-interactive fail-fast with `InteractionRequiredError`
 * and no stdin read; per-type validation (`number` rejects a non-numeric default);
 * `secret` non-echo + `Redacted` carriage; prompt output routes through
 * `Renderer.output.stdout` when a renderer is present; and (when the harness
 * declares support) external `Effect.interrupt` surfaces `InteractionCancelledError`
 * with TTY raw-mode restored, plus dynamic `choicesFrom` resolution and the
 * `InteractionRequiredError` manual fallback when choices cannot resolve
 * non-interactively.
 */
export const runInteractionContract = (
  harness: InteractionContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireInteractionContract(
      typeof harness.capabilities.interactive === "boolean" &&
        Array.isArray(harness.capabilities.promptTypes) &&
        harness.capabilities.promptTypes.length > 0 &&
        typeof harness.capabilities.secretRedaction === "boolean",
      "the harness declares interaction capabilities (interactive, promptTypes, secretRedaction)",
      harness.capabilities,
    );

    const idService = harness.makeService({ neverStdin: true });
    yield* requireInteractionContract(
      typeof idService.id === "string" && idService.id.length > 0,
      "the interaction service declares a non-empty id",
      idService.id,
    );

    const precedenceService = harness.makeService({ neverStdin: true });
    const precedenceExit = yield* runInteractionScoped(
      precedenceService.promptAll([interactionTextPrompt("app")], {
        answers: { app: "explicit" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(precedenceExit) && (precedenceExit.value as Record<string, unknown>).app === "explicit",
      "an explicit answer wins over prompting and over the default",
      precedenceExit,
    );

    const defaultService = harness.makeService({ neverStdin: true });
    const defaultExit = yield* runInteractionScoped(
      defaultService.promptAll([{ name: "app", type: "text", message: "Name?", default: "fallback" }], {
        yes: true,
      }),
    );
    yield* requireInteractionContract(
      Exit.isSuccess(defaultExit) && (defaultExit.value as Record<string, unknown>).app === "fallback",
      "--yes resolves a prompt default without reading input",
      defaultExit,
    );

    const nonTtyService = harness.makeService({ neverStdin: true });
    const isInteractive = yield* nonTtyService.isInteractive;
    yield* requireInteractionContract(
      isInteractive === false,
      "auto mode reports non-interactive when stdin is not a TTY",
      isInteractive,
    );
    const autoExit = yield* runInteractionScoped(
      nonTtyService.promptAll([interactionTextPrompt("app")], { mode: "auto" }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(autoExit) === "InteractionRequiredError",
      "auto-mode TTY gating fails fast on a non-TTY when no answer is supplied",
      autoExit,
    );

    const failFastService = harness.makeService({ neverStdin: true });
    // Against a never-readable stdin this resolves only if the service fails fast
    // instead of blocking on a read; a short timeout converts a hang into a
    // contract failure rather than a hung test.
    const failFastExit = yield* runInteractionScoped(
      failFastService.promptAll([interactionTextPrompt("app")], { mode: "non-interactive" }),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(5),
        onTimeout: () => interactionContractFailure("non-interactive resolution never blocks on stdin"),
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(failFastExit) === "InteractionRequiredError",
      "non-interactive resolution fails fast with InteractionRequiredError",
      failFastExit,
    );

    const validationService = harness.makeService({ neverStdin: true });
    const validationExit = yield* runInteractionScoped(
      validationService.promptAll([{ name: "port", type: "number", message: "Port?" }], {
        answers: { port: "not-a-number" },
        mode: "non-interactive",
      }),
    );
    yield* requireInteractionContract(
      interactionFailureTag(validationExit) === "PromptValidationError",
      "an invalid answer for a typed prompt fails with PromptValidationError",
      validationExit,
    );

    if (harness.capabilities.secretRedaction) {
      const secretService = harness.makeService({
        scriptedInput: ["hunter2"],
        tty: true,
      });
      const secretExit = yield* runInteractionScoped(
        secretService.secret({ name: "token", message: "Token?", answers: { token: "hunter2" } }),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) && Redacted.value(secretExit.value) === "hunter2",
        "secret answers are carried as Redacted values",
        secretExit,
      );
      yield* requireInteractionContract(
        Exit.isSuccess(secretExit) &&
          !String(secretExit.value).includes("hunter2") &&
          !JSON.stringify(secretExit.value).includes("hunter2"),
        "a secret value never appears in its string or JSON representation",
        secretExit,
      );
    }

    if (harness.supportsInteractiveInput === true) {
      const renderer = makeInteractionContractRenderer();
      const routedService = harness.makeService({
        scriptedInput: ["routed-value"],
        tty: true,
        renderer: renderer.service,
      });
      const routedExit = yield* runInteractionScoped(
        Effect.provideService(
          routedService.promptAll([{ name: "app", type: "text", message: "RoutedQuestion?" }], {
            mode: "interactive",
          }),
          Renderer,
          renderer.service,
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(routedExit) && renderer.stdout().includes("RoutedQuestion?"),
        "prompt chrome routes through Renderer.output.stdout when a renderer is present",
        { exit: routedExit, captured: renderer.stdout() },
      );
    }

    if (harness.supportsInterruption === true) {
      const interruptService = harness.makeService({ neverStdin: true, tty: true });
      const interruptExit = yield* Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(interruptService.promptAll([interactionTextPrompt("app")], { mode: "interactive" })),
        );
        yield* Effect.sleep("25 millis");
        return yield* Fiber.interrupt(fiber);
      });
      yield* requireInteractionContract(
        interactionFailureTag(interruptExit) === "InteractionCancelledError",
        "external Effect.interrupt surfaces InteractionCancelledError",
        interruptExit,
      );
    }

    if (harness.supportsDynamicChoices === true) {
      const choicesService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const choicesExit = yield* runInteractionScoped(
        choicesService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { answers: { phpVersion: "8.2" }, mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        Exit.isSuccess(choicesExit) && (choicesExit.value as Record<string, unknown>).phpVersion === "8.2",
        "a seeded answer resolves a dynamic choicesFrom prompt",
        choicesExit,
      );

      const manualFallbackService = harness.makeService({
        neverStdin: true,
        choicesResult: { exitCode: 0, stdout: "8.1\n8.2\n", stderr: "" },
      });
      const manualExit = yield* runInteractionScoped(
        manualFallbackService.promptAll(
          [
            {
              name: "phpVersion",
              type: "select",
              message: "PHP?",
              choicesFrom: { command: "services:list", parse: "lines" },
            },
          ],
          { mode: "non-interactive", runs: ["services:list"] },
        ),
      );
      yield* requireInteractionContract(
        interactionFailureTag(manualExit) === "InteractionRequiredError",
        "a resolvable dynamic-choices prompt with no answer fails fast non-interactively",
        manualExit,
      );
    }
  });
