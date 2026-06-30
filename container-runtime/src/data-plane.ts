import { randomUUID } from "node:crypto";

import { Effect, Fiber, type Scope, Stream } from "effect";

import { ArtifactTransferError, ServiceCopyError, VolumeOperationError } from "@lando/sdk/errors";
import {
  AppId,
  type AppPlan,
  type DataStoreMountPlan,
  ProviderId,
  type ServiceName,
} from "@lando/sdk/schema";
import type {
  ArtifactRef,
  EphemeralRunSpec,
  ExecChunk,
  ExecResult,
  ProviderError,
  RuntimeProviderShape,
} from "@lando/sdk/services";

export interface DataPlaneHttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface DataPlaneHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface DataPlaneApiClient {
  readonly request?: (request: DataPlaneHttpRequest) => Effect.Effect<DataPlaneHttpResponse, ProviderError>;
  readonly stream?: (request: DataPlaneHttpRequest) => Stream.Stream<Uint8Array, ProviderError>;
}

export interface ProviderDataPlaneOptions {
  readonly providerId: string;
  readonly api: DataPlaneApiClient;
  readonly snapshotMode: "copy" | "native";
  readonly redactDetails: (value: unknown) => unknown;
}

const textDecoder = new TextDecoder();

const concatBytes = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const parts = Array.from(chunks);
  const size = parts.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of parts) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const collectStreamBytes = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(chunks)),
  );

const oneChunk = (chunk: Uint8Array): AsyncIterable<Uint8Array> =>
  (async function* () {
    yield chunk;
  })();

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/gu, "-");
const volumeName = (store: string): string => store;
const serviceContainerName = (target: {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan?: AppPlan;
}): string =>
  `lando-${sanitize(target.plan?.slug ?? String(target.app))}-${sanitize(String(target.service))}`;
const ephemeralContainerName = (providerId: string): string =>
  `lando-${sanitize(providerId)}-data-${randomUUID()}`;

const firstDataStoreMount = (spec: EphemeralRunSpec): DataStoreMountPlan | undefined =>
  spec.mounts?.find((mount): mount is DataStoreMountPlan => "store" in mount);

const envList = (env: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> | undefined =>
  env === undefined ? undefined : Object.entries(env).map(([key, value]) => `${key}=${value}`);

const volumeError = (
  options: ProviderDataPlaneOptions,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  store?: string,
) =>
  new VolumeOperationError({
    providerId: options.providerId,
    operation,
    message,
    remediation: "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
    ...(details === undefined ? {} : { details: options.redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
    ...(store === undefined ? {} : { store }),
  });

const copyError = (
  options: ProviderDataPlaneOptions,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  service?: ServiceName,
) =>
  new ServiceCopyError({
    providerId: options.providerId,
    operation,
    message,
    remediation: "Retry the copy operation after verifying the target service is running.",
    ...(details === undefined ? {} : { details: options.redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
    ...(service === undefined ? {} : { service }),
  });

const artifactError = (
  options: ProviderDataPlaneOptions,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  artifactRef?: string,
) =>
  new ArtifactTransferError({
    providerId: options.providerId,
    operation,
    message,
    remediation: "Retry the artifact transfer after checking provider runtime health with `lando doctor`.",
    ...(details === undefined ? {} : { details: options.redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
  });

const request = (options: ProviderDataPlaneOptions, operation: string, input: DataPlaneHttpRequest) =>
  options.api.request === undefined
    ? Effect.fail(volumeError(options, operation, "Provider API request client is missing."))
    : options.api
        .request(input)
        .pipe(
          Effect.mapError((cause) =>
            volumeError(options, operation, "Provider API request failed.", input, cause),
          ),
        );

const stream = (options: ProviderDataPlaneOptions, operation: string, input: DataPlaneHttpRequest) =>
  options.api.stream === undefined
    ? Stream.fail(volumeError(options, operation, "Provider API stream client is missing."))
    : options.api
        .stream(input)
        .pipe(
          Stream.mapError((cause) =>
            volumeError(options, operation, "Provider API stream failed.", input, cause),
          ),
        );

const ensure2xx = (
  options: ProviderDataPlaneOptions,
  operation: string,
  response: DataPlaneHttpResponse,
  store?: string,
) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(
        volumeError(
          options,
          operation,
          `Provider data-plane API returned HTTP ${response.status}.`,
          response,
          undefined,
          store,
        ),
      );

const createEphemeralContainer = (options: ProviderDataPlaneOptions, spec: EphemeralRunSpec) => {
  const name = ephemeralContainerName(options.providerId);
  const mount = firstDataStoreMount(spec);
  const binds =
    mount === undefined ? [] : [`${volumeName(mount.store)}:${mount.target}${mount.readOnly ? ":ro" : ""}`];
  return request(options, "run.create", {
    method: "POST",
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body: {
      Image: spec.image,
      Cmd: spec.command,
      ...(envList(spec.env) === undefined ? {} : { Env: envList(spec.env) }),
      HostConfig: { Binds: binds },
      OpenStdin: spec.stdinStream !== undefined || spec.stdin === "inherit",
      AttachStdin: spec.stdinStream !== undefined || spec.stdin === "inherit",
      AttachStdout: spec.captureStdout === true,
    },
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "run.create", response, mount?.store)),
    Effect.as(name),
  );
};

const removeEphemeralContainer = (options: ProviderDataPlaneOptions, name: string, remove: boolean) =>
  remove
    ? request(options, "run.remove", {
        method: "DELETE",
        path: `/containers/${encodeURIComponent(name)}?force=true`,
      }).pipe(
        Effect.catchAll(() => Effect.void),
        Effect.asVoid,
      )
    : Effect.void;

const attachEphemeralStdin = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  spec.stdinStream === undefined
    ? Effect.void
    : collectStreamBytes(
        stream(options, "run.attach", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/attach?stream=true&stdin=true&stdout=false&stderr=false`,
          stdin: spec.stdinStream,
        }),
      ).pipe(Effect.asVoid);

const waitForEphemeralContainer = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  request(options, "run.wait", {
    method: "POST",
    path: `/containers/${encodeURIComponent(name)}/wait`,
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "run.wait", response, firstDataStoreMount(spec)?.store)),
  );

const runBytes = (options: ProviderDataPlaneOptions, spec: EphemeralRunSpec) =>
  Effect.acquireUseRelease(
    createEphemeralContainer(options, spec),
    (name) =>
      Effect.gen(function* () {
        const stdinFiber = yield* Effect.forkScoped(attachEphemeralStdin(options, name, spec));
        const start = yield* request(options, "run.start", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/start`,
        });
        yield* ensure2xx(options, "run.start", start, firstDataStoreMount(spec)?.store);
        if (spec.stdinStream === undefined) {
          yield* waitForEphemeralContainer(options, name, spec);
        } else {
          yield* Fiber.join(stdinFiber);
        }
        const stdout =
          spec.captureStdout === true
            ? yield* collectStreamBytes(
                stream(options, "run.logs", {
                  method: "GET",
                  path: `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=false`,
                }),
              )
            : new Uint8Array();
        const inspect = yield* request(options, "run.inspect", {
          method: "GET",
          path: `/containers/${encodeURIComponent(name)}/json`,
        });
        yield* ensure2xx(options, "run.inspect", inspect, firstDataStoreMount(spec)?.store);
        const parsed =
          inspect.body.length === 0 ? {} : (JSON.parse(inspect.body) as { State?: { ExitCode?: number } });
        return { exitCode: parsed.State?.ExitCode ?? 0, stdout, stderr: "" };
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.fail(
            volumeError(
              options,
              "run",
              "Provider ephemeral run failed.",
              undefined,
              cause,
              firstDataStoreMount(spec)?.store,
            ),
          ),
        ),
      ),
    (name) => removeEphemeralContainer(options, name, spec.remove !== false),
  );

export const makeProviderDataPlane = (options: ProviderDataPlaneOptions) => ({
  run: (spec: EphemeralRunSpec): Effect.Effect<ExecResult, ProviderError, Scope.Scope> =>
    runBytes(options, { ...spec, captureStdout: spec.captureStdout ?? false }).pipe(
      Effect.map(({ exitCode, stdout, stderr }) => ({
        exitCode,
        stdout: textDecoder.decode(stdout),
        stderr,
      })),
    ),
  runStream: (spec: EphemeralRunSpec): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> =>
    Stream.unwrap(
      runBytes(options, { ...spec, captureStdout: true }).pipe(
        Effect.map(({ exitCode, stdout }) =>
          Stream.make({ kind: "stdout" as const, chunk: stdout }, { exitCode }),
        ),
      ),
    ),
  snapshotVolume: ((spec) => {
    const store = spec.volume.store;
    const name = volumeName(store);
    if (options.snapshotMode === "native") {
      return request(options, "snapshotVolume", {
        method: "POST",
        path: `/libpod/volumes/${encodeURIComponent(name)}/snapshot`,
      }).pipe(
        Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, store)),
        Effect.map((response) => {
          const parsed = response.body.length === 0 ? {} : (JSON.parse(response.body) as { id?: string });
          return { provider: ProviderId.make(options.providerId), id: parsed.id ?? `${name}-snapshot` };
        }),
        Effect.mapError((cause) =>
          volumeError(options, "snapshotVolume", "Provider volume snapshot failed.", undefined, cause, store),
        ),
      );
    }
    const id = spec.snapshotId ?? `${name}-snapshot-${randomUUID()}`;
    return collectStreamBytes(
      stream(options, "snapshotVolume", {
        method: "GET",
        path: `/volumes/${encodeURIComponent(name)}/archive`,
      }),
    ).pipe(
      Effect.flatMap((payload) =>
        request(options, "snapshotVolume", {
          method: "POST",
          path: `/volumes/snapshots/${encodeURIComponent(id)}`,
          stdin: oneChunk(payload),
        }),
      ),
      Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, store)),
      Effect.as({ provider: ProviderId.make(options.providerId), id }),
      Effect.mapError((cause) =>
        volumeError(options, "snapshotVolume", "Provider volume snapshot failed.", undefined, cause, store),
      ),
    );
  }) satisfies RuntimeProviderShape["snapshotVolume"],
  restoreVolume: ((spec) => {
    const store = spec.target.store;
    const name = volumeName(store);
    if (options.snapshotMode === "native") {
      return request(options, "restoreVolume", {
        method: "POST",
        path: `/libpod/volumes/${encodeURIComponent(name)}/restore?snapshot=${encodeURIComponent(spec.snapshot.id)}`,
      }).pipe(
        Effect.tap((response) => ensure2xx(options, "restoreVolume", response, store)),
        Effect.asVoid,
        Effect.mapError((cause) =>
          volumeError(options, "restoreVolume", "Provider volume restore failed.", undefined, cause, store),
        ),
      );
    }
    return collectStreamBytes(
      stream(options, "restoreVolume", {
        method: "GET",
        path: `/volumes/snapshots/${encodeURIComponent(spec.snapshot.id)}`,
      }),
    ).pipe(
      Effect.flatMap((payload) =>
        request(options, "restoreVolume", {
          method: "POST",
          path: `/volumes/${encodeURIComponent(name)}/archive?overwrite=${String(spec.overwrite ?? false)}`,
          stdin: oneChunk(payload),
        }),
      ),
      Effect.tap((response) => ensure2xx(options, "restoreVolume", response, store)),
      Effect.asVoid,
      Effect.mapError((cause) =>
        volumeError(options, "restoreVolume", "Provider volume restore failed.", undefined, cause, store),
      ),
    );
  }) satisfies RuntimeProviderShape["restoreVolume"],
  listVolumes: ((filter) =>
    request(options, "listVolumes", { method: "GET", path: "/volumes" }).pipe(
      Effect.tap((response) => ensure2xx(options, "listVolumes", response, filter.store)),
      Effect.map((response) => {
        const parsed =
          response.body.length === 0
            ? { Volumes: [] }
            : (JSON.parse(response.body) as {
                Volumes?: ReadonlyArray<{ Name?: string; Labels?: Readonly<Record<string, string>> }>;
              });
        return (parsed.Volumes ?? []).map((volume) => ({
          ref: {
            app: filter.app ?? AppId.make("unknown"),
            store: volume.Name ?? filter.store ?? "data",
            ...(filter.scope === undefined ? {} : { scope: filter.scope }),
          },
          ...(volume.Labels === undefined ? {} : { labels: volume.Labels }),
        }));
      }),
      Effect.mapError((cause) =>
        volumeError(options, "listVolumes", "Provider volume list failed.", undefined, cause, filter.store),
      ),
    )) satisfies RuntimeProviderShape["listVolumes"],
  removeVolume: ((ref) =>
    request(options, "removeVolume", {
      method: "DELETE",
      path: `/volumes/${encodeURIComponent(volumeName(ref.store))}`,
    }).pipe(
      Effect.tap((response) => ensure2xx(options, "removeVolume", response, ref.store)),
      Effect.asVoid,
      Effect.mapError((cause) =>
        volumeError(options, "removeVolume", "Provider volume remove failed.", undefined, cause, ref.store),
      ),
    )) satisfies RuntimeProviderShape["removeVolume"],
  copyToService: ((target, spec) =>
    Effect.tryPromise({
      try: async () => new Uint8Array(await Bun.file(spec.sourcePath).arrayBuffer()),
      catch: (cause) =>
        copyError(
          options,
          "copyToService",
          "Failed to read copy source.",
          { sourcePath: spec.sourcePath },
          cause,
          target.service,
        ),
    }).pipe(
      Effect.flatMap((payload) =>
        request(options, "copyToService", {
          method: "POST",
          path: `/containers/${encodeURIComponent(serviceContainerName(target))}/archive?path=${encodeURIComponent(spec.targetPath)}&overwrite=${String(spec.overwrite ?? false)}`,
          stdin: oneChunk(payload),
        }).pipe(
          Effect.mapError((cause) =>
            copyError(
              options,
              "copyToService",
              "Provider service copy-in failed.",
              undefined,
              cause,
              target.service,
            ),
          ),
        ),
      ),
      Effect.tap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : Effect.fail(
              copyError(
                options,
                "copyToService",
                `Provider service copy-in returned HTTP ${response.status}.`,
                response,
                undefined,
                target.service,
              ),
            ),
      ),
      Effect.asVoid,
    )) satisfies RuntimeProviderShape["copyToService"],
  copyFromService: ((target, spec) =>
    stream(options, "copyFromService", {
      method: "GET",
      path: `/containers/${encodeURIComponent(serviceContainerName(target))}/archive?path=${encodeURIComponent(spec.sourcePath)}`,
    }).pipe(
      Stream.mapError((cause) =>
        copyError(
          options,
          "copyFromService",
          "Provider service copy-out failed.",
          undefined,
          cause,
          target.service,
        ),
      ),
    )) satisfies RuntimeProviderShape["copyFromService"],
  exportArtifact: ((ref: ArtifactRef) =>
    stream(options, "exportArtifact", {
      method: "GET",
      path: `/images/${encodeURIComponent(ref.ref)}/get`,
    }).pipe(
      Stream.mapError((cause) =>
        artifactError(
          options,
          "exportArtifact",
          "Provider artifact export failed.",
          undefined,
          cause,
          ref.ref,
        ),
      ),
    )) satisfies RuntimeProviderShape["exportArtifact"],
  importArtifact: ((data) =>
    collectStreamBytes(data).pipe(
      Effect.mapError((cause) =>
        artifactError(options, "importArtifact", "Failed to read artifact import stream.", undefined, cause),
      ),
      Effect.flatMap((payload) =>
        request(options, "importArtifact", {
          method: "POST",
          path: "/images/load",
          stdin: oneChunk(payload),
        }).pipe(
          Effect.mapError((cause) =>
            artifactError(options, "importArtifact", "Provider artifact import failed.", undefined, cause),
          ),
        ),
      ),
      Effect.tap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : Effect.fail(
              artifactError(
                options,
                "importArtifact",
                `Provider artifact import returned HTTP ${response.status}.`,
                response,
              ),
            ),
      ),
      Effect.map((response) => {
        const parsed = response.body.length === 0 ? {} : (JSON.parse(response.body) as { ref?: string });
        return {
          providerId: ProviderId.make(options.providerId),
          ref: parsed.ref ?? `imported:${randomUUID()}`,
        };
      }),
    )) satisfies RuntimeProviderShape["importArtifact"],
});
