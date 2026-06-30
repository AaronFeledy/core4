import { randomUUID } from "node:crypto";

import { Effect, Fiber, type Scope, Stream } from "effect";

import { ArtifactTransferError, ServiceCopyError, VolumeOperationError } from "@lando/sdk/errors";
import {
  AppId,
  type AppPlan,
  type DataStoreMountPlan,
  PortablePath,
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
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
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

const tarBlockSize = 512;

const padToBlock = (size: number): number => Math.ceil(size / tarBlockSize) * tarBlockSize;

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number) => {
  target.set(new TextEncoder().encode(value).slice(0, length), offset);
};

const octal = (value: number, width: number): string | undefined => {
  const text = value.toString(8);
  if (text.length > width - 1) return undefined;
  return text.padStart(width - 1, "0");
};

const archiveFile = (name: string, payload: Uint8Array): Uint8Array | undefined => {
  if (name.length === 0 || new TextEncoder().encode(name).byteLength > 100) return undefined;
  const mode = octal(0o644, 8);
  const uid = octal(0, 8);
  const gid = octal(0, 8);
  const size = octal(payload.byteLength, 12);
  const mtime = octal(0, 12);
  if (
    mode === undefined ||
    uid === undefined ||
    gid === undefined ||
    size === undefined ||
    mtime === undefined
  ) {
    return undefined;
  }
  const header = new Uint8Array(tarBlockSize);
  writeAscii(header, 0, name, 100);
  writeAscii(header, 100, `${mode}\0`, 8);
  writeAscii(header, 108, `${uid}\0`, 8);
  writeAscii(header, 116, `${gid}\0`, 8);
  writeAscii(header, 124, `${size}\0`, 12);
  writeAscii(header, 136, `${mtime}\0`, 12);
  header.fill(32, 148, 156);
  header[156] = 48;
  writeAscii(header, 257, "ustar", 6);
  writeAscii(header, 263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumOctal = octal(checksum, 7);
  if (checksumOctal === undefined) return undefined;
  writeAscii(header, 148, `${checksumOctal}\0 `, 8);
  const output = new Uint8Array(tarBlockSize + padToBlock(payload.byteLength) + tarBlockSize * 2);
  output.set(header, 0);
  output.set(payload, tarBlockSize);
  return output;
};

const extractFirstTarFile = (archive: Uint8Array): Uint8Array | undefined => {
  if (archive.byteLength < tarBlockSize) return undefined;
  const header = archive.slice(0, tarBlockSize);
  const sizeRaw = textDecoder.decode(header.slice(124, 136)).replace(/\0.*$/u, "").trim();
  const size = Number.parseInt(sizeRaw || "0", 8);
  if (!Number.isFinite(size) || size < 0) return undefined;
  const start = tarBlockSize;
  const end = start + size;
  if (end > archive.byteLength) return undefined;
  return archive.slice(start, end);
};

const decodeDockerMultiplexedStdout = (payload: Uint8Array): Uint8Array => {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.byteLength) {
    if (payload.byteLength - offset < 8) return payload;
    const streamType = payload[offset] ?? -1;
    if (streamType !== 1 && streamType !== 2) return payload;
    const reserved1 = payload[offset + 1] ?? -1;
    const reserved2 = payload[offset + 2] ?? -1;
    const reserved3 = payload[offset + 3] ?? -1;
    if (reserved1 !== 0 || reserved2 !== 0 || reserved3 !== 0) return payload;
    const length = new DataView(payload.buffer, payload.byteOffset + offset + 4, 4).getUint32(0);
    const start = offset + 8;
    const end = start + length;
    if (length < 0 || end > payload.byteLength) return payload;
    if (streamType === 1) frames.push(payload.slice(start, end));
    offset = end;
  }
  return frames.length === 0 ? new Uint8Array() : concatBytes(frames);
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

const basename = (path: string): string => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
const dirname = (path: string): string => {
  const normalized = path.replace(/\\/gu, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
};

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

const copyModeHelperImage = "alpine:3.20";
const copyModeMountPath = "/lando-data";
const copyModeMountTarget = PortablePath.make(copyModeMountPath);
const nativeSnapshotRepo = "localhost/lando-volume-snapshot";

const nativeSnapshotImage = (id: string): string => `${nativeSnapshotRepo}:${sanitize(id).toLowerCase()}`;

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
      StdinOnce: spec.stdinStream !== undefined,
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

const attachEphemeralStdin = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) => {
  const stdin = spec.stdinStream;
  if (stdin === undefined) return Effect.void;
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      collectStreamBytes(
        stream(options, "run.attach", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/attach?stream=true&stdin=true&stdout=false&stderr=false`,
          signal: controller.signal,
          stdin: closeAfterStdin(stdin, controller),
        }),
      ).pipe(Effect.asVoid),
    (controller) => Effect.sync(() => controller.abort()),
  );
};

const closeAfterStdin = (
  stdin: AsyncIterable<Uint8Array>,
  controller: AbortController,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    try {
      yield* stdin;
    } finally {
      controller.abort();
    }
  },
});

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
        if (spec.stdinStream !== undefined) {
          yield* Fiber.join(stdinFiber);
        }
        yield* waitForEphemeralContainer(options, name, spec);
        const stdout =
          spec.captureStdout === true
            ? yield* collectStreamBytes(
                stream(options, "run.logs", {
                  method: "GET",
                  path: `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=false`,
                }),
              ).pipe(Effect.map(decodeDockerMultiplexedStdout))
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

const commitNativeSnapshot = (
  options: ProviderDataPlaneOptions,
  containerName: string,
  snapshotId: string,
  store: string,
) => {
  const tag = sanitize(snapshotId).toLowerCase();
  return request(options, "snapshotVolume", {
    method: "POST",
    path: `/commit?container=${encodeURIComponent(containerName)}&repo=${encodeURIComponent(nativeSnapshotRepo)}&tag=${encodeURIComponent(tag)}`,
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, store)),
    Effect.as({ provider: ProviderId.make(options.providerId), id: snapshotId }),
  );
};

const snapshotVolumeWithCommit = (options: ProviderDataPlaneOptions, store: string, snapshotId: string) =>
  Effect.acquireUseRelease(
    createEphemeralContainer(options, {
      image: copyModeHelperImage,
      command: ["sh", "-c", "rm -rf /snapshot && mkdir -p /snapshot && cp -a /lando-data/. /snapshot/"],
      mounts: [{ store: volumeName(store), target: copyModeMountTarget, readOnly: true }],
      remove: true,
    }),
    (name) =>
      Effect.gen(function* () {
        const start = yield* request(options, "snapshotVolume", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/start`,
        });
        yield* ensure2xx(options, "snapshotVolume", start, store);
        const wait = yield* request(options, "snapshotVolume", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/wait`,
        });
        yield* ensure2xx(options, "snapshotVolume", wait, store);
        const parsed = wait.body.length === 0 ? {} : (JSON.parse(wait.body) as { StatusCode?: number });
        if (parsed.StatusCode !== 0) {
          return yield* Effect.fail(
            volumeError(
              options,
              "snapshotVolume",
              "Provider volume snapshot helper failed.",
              wait,
              undefined,
              store,
            ),
          );
        }
        return yield* commitNativeSnapshot(options, name, snapshotId, store);
      }),
    (name) => removeEphemeralContainer(options, name, true),
  );

export const makeProviderDataPlane = (options: ProviderDataPlaneOptions) => {
  const copyModeSnapshots = new Map<string, Uint8Array>();

  return {
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
      const id = spec.snapshotId ?? `${name}-snapshot-${randomUUID()}`;
      if (options.snapshotMode === "native") {
        return snapshotVolumeWithCommit(options, store, id).pipe(
          Effect.mapError((cause) =>
            volumeError(
              options,
              "snapshotVolume",
              "Provider volume snapshot failed.",
              undefined,
              cause,
              store,
            ),
          ),
        );
      }
      return runBytes(options, {
        image: copyModeHelperImage,
        command: ["tar", "-C", copyModeMountPath, "-cf", "-", "."],
        mounts: [{ store: name, target: copyModeMountTarget, readOnly: true }],
        captureStdout: true,
        remove: true,
      }).pipe(
        Effect.map(({ stdout }) => stdout),
        Effect.tap((payload) => Effect.sync(() => copyModeSnapshots.set(id, payload))),
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
        return runBytes(options, {
          image: nativeSnapshotImage(spec.snapshot.id),
          command: [
            "sh",
            "-c",
            "find /lando-data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /snapshot/. /lando-data/",
          ],
          mounts: [{ store: name, target: copyModeMountTarget, readOnly: false }],
          remove: true,
        }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.fail(
                  volumeError(
                    options,
                    "restoreVolume",
                    "Provider volume restore helper failed.",
                    result,
                    undefined,
                    store,
                  ),
                ),
          ),
          Effect.mapError((cause) =>
            volumeError(options, "restoreVolume", "Provider volume restore failed.", undefined, cause, store),
          ),
        );
      }
      const payload = copyModeSnapshots.get(spec.snapshot.id);
      if (payload === undefined) {
        return Effect.fail(
          volumeError(
            options,
            "restoreVolume",
            "Provider copy-mode snapshot was not found.",
            undefined,
            undefined,
            store,
          ),
        );
      }
      return runBytes(options, {
        image: copyModeHelperImage,
        command: ["tar", "-C", copyModeMountPath, "-xf", "-"],
        mounts: [{ store: name, target: copyModeMountTarget, readOnly: false }],
        stdinStream: oneChunk(payload),
        remove: true,
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(
                volumeError(
                  options,
                  "restoreVolume",
                  "Provider volume restore helper failed.",
                  result,
                  undefined,
                  store,
                ),
              ),
        ),
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
        Effect.flatMap((payload) => {
          const archive = archiveFile(basename(spec.targetPath), payload);
          return archive === undefined
            ? Effect.fail(
                copyError(
                  options,
                  "copyToService",
                  "Failed to archive copy source.",
                  { sourcePath: spec.sourcePath },
                  undefined,
                  target.service,
                ),
              )
            : Effect.succeed(archive);
        }),
        Effect.flatMap((payload) =>
          request(options, "copyToService", {
            method: "PUT",
            path: `/containers/${encodeURIComponent(serviceContainerName(target))}/archive?path=${encodeURIComponent(dirname(spec.targetPath))}&overwrite=${String(spec.overwrite ?? false)}`,
            headers: { "Content-Type": "application/x-tar" },
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
      Stream.unwrap(
        collectStreamBytes(
          stream(options, "copyFromService", {
            method: "GET",
            path: `/containers/${encodeURIComponent(serviceContainerName(target))}/archive?path=${encodeURIComponent(spec.sourcePath)}`,
          }),
        ).pipe(
          Effect.flatMap((archive) => {
            const payload = extractFirstTarFile(archive);
            return payload === undefined
              ? Effect.fail(
                  copyError(
                    options,
                    "copyFromService",
                    "Failed to extract provider service copy archive.",
                    { sourcePath: spec.sourcePath },
                    undefined,
                    target.service,
                  ),
                )
              : Effect.succeed(payload);
          }),
          Effect.map((payload) => Stream.make(payload)),
          Effect.mapError((cause) =>
            copyError(
              options,
              "copyFromService",
              "Provider service copy-out failed.",
              undefined,
              cause,
              target.service,
            ),
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
          artifactError(
            options,
            "importArtifact",
            "Failed to read artifact import stream.",
            undefined,
            cause,
          ),
        ),
        Effect.flatMap((payload) =>
          request(options, "importArtifact", {
            method: "POST",
            path: "/images/load",
            headers: { "Content-Type": "application/x-tar" },
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
          const parsed =
            response.body.length === 0
              ? {}
              : (JSON.parse(response.body) as { ref?: string; stream?: string });
          const loadedRef = parsed.stream?.match(/Loaded image:\s*(\S+)/u)?.[1];
          return {
            providerId: ProviderId.make(options.providerId),
            ref: parsed.ref ?? loadedRef ?? `imported:${randomUUID()}`,
          };
        }),
      )) satisfies RuntimeProviderShape["importArtifact"],
  };
};
