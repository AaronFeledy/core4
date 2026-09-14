import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { makeAttachDecoder } from "./streams.ts";
import {
  type MountedVolumeTarget,
  type VolumeAdoptionTarget,
  adoptMountedVolume,
  locateVolume,
  observeMountedVolume,
} from "./volume-observation.ts";
import { VOLUME_WITNESS_FILE, VOLUME_WITNESS_IMAGE } from "./volume-witness-helper.ts";
export { volumeCreationOwnerLabels } from "./volume-observation.ts";
export { volumeCreationFact } from "./volume-creation.ts";
export { VOLUME_WITNESS_IMAGE } from "./volume-witness-helper.ts";

import { Effect, Fiber, type Scope, Stream } from "effect";

import { ArtifactTransferError, ServiceCopyError, VolumeOperationError } from "@lando/sdk/errors";
import {
  AppId,
  type AppPlan,
  type DataStoreMountPlan,
  PortablePath,
  ProviderId,
  type ServiceName,
  type StorageScope,
  type VolumeInfo,
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
  readonly endpointNamespace?: string;
  readonly prepareWitnessImage?: Effect.Effect<unknown, ProviderError>;
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

const archiveFileHeader = (name: string, payloadSize: number): Uint8Array | undefined => {
  if (name.length === 0 || new TextEncoder().encode(name).byteLength > 100) return undefined;
  const mode = octal(0o644, 8);
  const uid = octal(0, 8);
  const gid = octal(0, 8);
  const size = octal(payloadSize, 12);
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
  return header;
};

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right;
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};

const extractFirstTarFile = async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let remaining: number | undefined;
  for await (const chunk of source) {
    buffered = appendBytes(buffered, chunk);
    if (remaining === undefined) {
      if (buffered.byteLength < tarBlockSize) continue;
      const sizeRaw = textDecoder.decode(buffered.subarray(124, 136)).replaceAll("\0", "").trim();
      remaining = sizeRaw.length === 0 ? 0 : Number.parseInt(sizeRaw, 8);
      if (!Number.isSafeInteger(remaining) || remaining < 0)
        throw new RangeError("Invalid tar payload size.");
      buffered = buffered.subarray(tarBlockSize);
    }
    if (remaining > 0 && buffered.byteLength > 0) {
      const count = Math.min(remaining, buffered.byteLength);
      yield buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      remaining -= count;
    }
  }
  if (remaining === undefined || remaining !== 0) throw new RangeError("Truncated tar payload.");
};

const decodeDockerRunLogs = (
  payload: Uint8Array,
  rawStream: "stdout" | "stderr",
): {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly chunks: ReadonlyArray<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>>;
} => {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const chunks: Array<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>> = [];
  const raw = () => ({
    stdout: rawStream === "stdout" ? payload : new Uint8Array(),
    stderr: rawStream === "stderr" ? payload : new Uint8Array(),
    chunks: payload.byteLength === 0 ? [] : [{ kind: rawStream, chunk: payload }],
  });
  let offset = 0;
  while (offset < payload.byteLength) {
    if (payload.byteLength - offset < 8) return raw();
    const streamType = payload[offset] ?? -1;
    if (streamType !== 1 && streamType !== 2) return raw();
    const reserved1 = payload[offset + 1] ?? -1;
    const reserved2 = payload[offset + 2] ?? -1;
    const reserved3 = payload[offset + 3] ?? -1;
    if (reserved1 !== 0 || reserved2 !== 0 || reserved3 !== 0) return raw();
    const length = new DataView(payload.buffer, payload.byteOffset + offset + 4, 4).getUint32(0, false);
    const start = offset + 8;
    const end = start + length;
    if (end > payload.byteLength) return raw();
    const chunk = payload.slice(start, end);
    if (streamType === 1) {
      stdout.push(chunk);
      chunks.push({ kind: "stdout", chunk });
    } else {
      stderr.push(chunk);
      chunks.push({ kind: "stderr", chunk });
    }
    offset = end;
  }
  return { stdout: concatBytes(stdout), stderr: concatBytes(stderr), chunks };
};

const collectStreamBytes = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(chunks)),
  );

const basename = (path: string): string => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
const dirname = (path: string): string => {
  const normalized = path.replace(/\\/gu, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
};

const parseImportArtifactResponse = (body: string): { ref?: string } => {
  let ref: string | undefined;
  const streams: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        ref?: unknown;
        stream?: unknown;
        aux?: { readonly ID?: unknown };
      };
      if (typeof parsed.ref === "string" && parsed.ref.length > 0) ref = parsed.ref;
      if (typeof parsed.aux?.ID === "string" && parsed.aux.ID.length > 0) ref = parsed.aux.ID;
      if (typeof parsed.stream === "string") streams.push(parsed.stream);
    } catch {
      streams.push(trimmed);
    }
  }
  const loadedRef = streams.join("").match(/Loaded image:\s*(\S+)/u)?.[1];
  if (ref !== undefined) return { ref };
  if (loadedRef !== undefined) return { ref: loadedRef };
  return {};
};

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/gu, "-");
const volumeName = (store: string): string => store;
const serviceContainerName = (target: {
  readonly app: AppId;
  readonly service: ServiceName;
  readonly plan?: AppPlan;
}): string | undefined =>
  target.plan === undefined
    ? undefined
    : `lando-${sanitize(target.plan.slug)}-${sanitize(String(target.service))}`;
const ephemeralContainerName = (providerId: string): string =>
  `lando-${sanitize(providerId)}-data-${randomUUID()}`;

const firstDataStoreMount = (spec: EphemeralRunSpec): DataStoreMountPlan | undefined =>
  spec.mounts?.find((mount): mount is DataStoreMountPlan => "store" in mount);

const dataStoreMounts = (spec: EphemeralRunSpec): ReadonlyArray<DataStoreMountPlan> =>
  spec.mounts?.filter((mount): mount is DataStoreMountPlan => "store" in mount) ?? [];

const envList = (env: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> | undefined =>
  env === undefined ? undefined : Object.entries(env).map(([key, value]) => `${key}=${value}`);

const copyModeHelperImage = "alpine:3.20";
const preserveWitness = `! -name '${VOLUME_WITNESS_FILE}' ! -name '.lando-witness-stage-*'`;
const excludeWitness = `--exclude='${VOLUME_WITNESS_FILE}' --exclude='./${VOLUME_WITNESS_FILE}' --exclude='.lando-witness-stage-*' --exclude='./.lando-witness-stage-*'`;
const copyModeMountPath = "/lando-data";
const copyModeMountTarget = PortablePath.make(copyModeMountPath);
const copyModeSnapshotMountPath = "/lando-snapshots";
const copyModeSnapshotMountTarget = PortablePath.make(copyModeSnapshotMountPath);
const nativeSnapshotRepo = "localhost/lando-volume-snapshot";

const copyModeSnapshotStore = (providerId: string): string => `lando-${sanitize(providerId)}-copy-snapshots`;

const copyModeSnapshotFile = (snapshotId: string): string => `${sanitize(snapshotId)}.tar`;

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

const requireServiceContainerName = (
  options: ProviderDataPlaneOptions,
  operation: "copyToService" | "copyFromService",
  target: { readonly app: AppId; readonly service: ServiceName; readonly plan?: AppPlan },
): Effect.Effect<string, ServiceCopyError> => {
  const name = serviceContainerName(target);
  return name === undefined
    ? Effect.fail(
        copyError(
          options,
          operation,
          "Provider service copy requires an applied app plan.",
          { app: target.app, service: target.service },
          undefined,
          target.service,
        ),
      )
    : Effect.succeed(name);
};

interface EngineVolume {
  readonly Name?: string;
  readonly Labels?: Readonly<Record<string, string>>;
  readonly CreatedAt?: string;
}

const landoVolumeLabels = {
  app: "dev.lando.app",
  store: "dev.lando.store",
  scope: "dev.lando.scope",
  instance: "dev.lando.volume-instance",
} as const;

const storageScopeFromLabel = (value: string | undefined): StorageScope | undefined =>
  value === "service" || value === "app" || value === "global" ? value : undefined;

const labelsMatch = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>> | undefined,
): boolean =>
  expected === undefined || Object.entries(expected).every(([key, value]) => actual[key] === value);

const volumeInfoFromEngineVolume = (
  volume: EngineVolume,
  filter: Parameters<RuntimeProviderShape["listVolumes"]>[0],
): VolumeInfo | undefined => {
  const labels = volume.Labels ?? {};
  const labelApp = labels[landoVolumeLabels.app];
  const labelStore = labels[landoVolumeLabels.store];
  const labelScope = storageScopeFromLabel(labels[landoVolumeLabels.scope]);
  const instanceId = labels[landoVolumeLabels.instance];
  if (labelApp === undefined || labelStore === undefined) return undefined;
  const store = labelStore;
  if (filter.app !== undefined && labelApp !== String(filter.app)) return undefined;
  if (filter.store !== undefined && filter.store !== store) return undefined;
  if (filter.scope !== undefined && labelScope !== filter.scope) return undefined;
  if (!labelsMatch(labels, filter.labels)) return undefined;
  return {
    ref: {
      app: AppId.make(labelApp),
      store,
      ...(labelScope === undefined
        ? filter.scope === undefined
          ? {}
          : { scope: filter.scope }
        : { scope: labelScope }),
    },
    ...(instanceId === undefined
      ? { provenance: "legacy" as const }
      : {
          instanceId,
          provenance: "known" as const,
        }),
    ...(volume.Labels === undefined ? {} : { labels: volume.Labels }),
  };
};

const legacyVolumeInfoFromEngineVolume = (
  volume: EngineVolume,
  filter: Parameters<RuntimeProviderShape["listVolumes"]>[0],
): VolumeInfo | undefined => {
  const labels = volume.Labels ?? {};
  if (labels[landoVolumeLabels.app] !== undefined || labels[landoVolumeLabels.store] !== undefined) {
    return undefined;
  }
  if (filter.app === undefined || filter.store === undefined) return undefined;
  if (filter.labels !== undefined || volume.Name !== volumeName(filter.store)) return undefined;
  return {
    ref: {
      app: filter.app,
      store: filter.store,
      ...(filter.scope === undefined ? {} : { scope: filter.scope }),
    },
    provenance: "legacy",
    ...(volume.Labels === undefined ? {} : { labels: volume.Labels }),
  };
};

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

interface WitnessMountSource {
  readonly containerId: string;
  readonly readOnly: boolean;
}

const createEphemeralContainer = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
  witnessSource?: WitnessMountSource,
) => {
  const name = ephemeralContainerName(options.providerId);
  const mount = firstDataStoreMount(spec);
  const binds = dataStoreMounts(spec).map(
    (mount) => `${volumeName(mount.store)}:${mount.target}${mount.readOnly ? ":ro" : ""}`,
  );
  const attachStdin = spec.stdinStream !== undefined;
  return request(options, "run.create", {
    method: "POST",
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body: {
      Image: spec.image,
      Cmd: spec.command,
      ...(envList(spec.env) === undefined ? {} : { Env: envList(spec.env) }),
      ...(witnessSource === undefined
        ? { HostConfig: { Binds: binds } }
        : {
            User: "0:0",
            Entrypoint: [],
            HostConfig: {
              VolumesFrom: [`${witnessSource.containerId}:${witnessSource.readOnly ? "ro" : "rw"}`],
              NetworkMode: "none",
              ReadonlyRootfs: true,
            },
          }),
      OpenStdin: attachStdin,
      AttachStdin: attachStdin,
      StdinOnce: attachStdin,
      AttachStdout: spec.captureStdout === true,
      AttachStderr: true,
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

const inspectEphemeralExitCode = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  request(options, "run.inspect", {
    method: "GET",
    path: `/containers/${encodeURIComponent(name)}/json`,
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "run.inspect", response, firstDataStoreMount(spec)?.store)),
    Effect.map((response) => {
      const parsed =
        response.body.length === 0 ? {} : (JSON.parse(response.body) as { State?: { ExitCode?: number } });
      return parsed.State?.ExitCode ?? 0;
    }),
  );

const runBytes = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
  witnessSource?: WitnessMountSource,
) =>
  Effect.acquireUseRelease(
    createEphemeralContainer(options, spec, witnessSource),
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
        const captureStdout = spec.captureStdout === true;
        const logs = yield* collectStreamBytes(
          stream(options, "run.logs", {
            method: "GET",
            path: `/containers/${encodeURIComponent(name)}/logs?stdout=${captureStdout ? "true" : "false"}&stderr=true`,
          }),
        ).pipe(Effect.map((payload) => decodeDockerRunLogs(payload, captureStdout ? "stdout" : "stderr")));
        const exitCode = yield* inspectEphemeralExitCode(options, name, spec);
        return {
          exitCode,
          stdout: logs.stdout,
          stderr: textDecoder.decode(logs.stderr),
          chunks: logs.chunks,
        };
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

const runByteStream = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> => {
  const decode = makeAttachDecoder();
  return Stream.acquireRelease(createEphemeralContainer(options, { ...spec, captureStdout: true }), (name) =>
    removeEphemeralContainer(options, name, spec.remove !== false),
  ).pipe(
    Stream.flatMap((name) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stdinFiber = yield* Effect.forkScoped(attachEphemeralStdin(options, name, spec));
          const started = yield* request(options, "run.start", {
            method: "POST",
            path: `/containers/${encodeURIComponent(name)}/start`,
          });
          yield* ensure2xx(options, "run.start", started, firstDataStoreMount(spec)?.store);
          const output = stream(options, "run.logs", {
            method: "GET",
            path: `/containers/${encodeURIComponent(name)}/logs?follow=true&stdout=true&stderr=true`,
          }).pipe(
            Stream.mapConcat((chunk) =>
              decode(chunk).map(
                (frame): ExecChunk => ({ kind: frame.stream, chunk: new Uint8Array(frame.payload) }),
              ),
            ),
          );
          const completed = Stream.fromEffect(
            Effect.gen(function* () {
              if (spec.stdinStream !== undefined) yield* Fiber.join(stdinFiber);
              yield* waitForEphemeralContainer(options, name, spec);
              return { exitCode: yield* inspectEphemeralExitCode(options, name, spec) } satisfies ExecChunk;
            }),
          );
          return Stream.concat(output, completed);
        }).pipe(
          Effect.mapError((cause) =>
            volumeError(
              options,
              "runStream",
              "Provider ephemeral stream failed.",
              undefined,
              cause,
              firstDataStoreMount(spec)?.store,
            ),
          ),
        ),
      ),
    ),
  );
};

const parseSnapshotMetrics = (
  options: ProviderDataPlaneOptions,
  output: string,
  format: "tar" | "native",
  store: string,
): Effect.Effect<
  { readonly digest: string; readonly sizeBytes: number; readonly format: "tar" | "native" },
  ProviderError
> => {
  const match = output.trim().match(/^(\S+)\s+(\d+)$/u);
  const sizeBytes = match === null ? Number.NaN : Number(match[2]);
  return match !== null && match[1] !== undefined && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
    ? Effect.succeed({ digest: match[1], sizeBytes, format })
    : Effect.fail(
        volumeError(
          options,
          "snapshotVolume",
          "Provider snapshot integrity output was invalid.",
          output,
          undefined,
          store,
        ),
      );
};

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
      command: [
        "sh",
        "-c",
        `mkdir -p /snapshot && find /lando-data -mindepth 1 -maxdepth 1 ${preserveWitness} -exec sh -c 'cp -a -- "$@" /snapshot/' sh {} +`,
      ],
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
        if (parsed.StatusCode !== undefined && parsed.StatusCode !== 0) {
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
  const observation = {
    ...options,
    runWitness: (target: MountedVolumeTarget, command: readonly string[]) =>
      request(options, "witness.image", {
        method: "GET",
        path: `/images/${encodeURIComponent(VOLUME_WITNESS_IMAGE)}/json`,
      }).pipe(
        Effect.flatMap((image) =>
          image.status === 404 && options.prepareWitnessImage !== undefined
            ? options.prepareWitnessImage
            : ensure2xx(options, "witness.image", image),
        ),
        Effect.zipRight(
          Effect.scoped(
            runBytes(
              options,
              { image: VOLUME_WITNESS_IMAGE, command, captureStdout: true, remove: true },
              { containerId: target.containerId, readOnly: false },
            ),
          ).pipe(
            Effect.map((result) => ({
              exitCode: result.exitCode,
              stdout: textDecoder.decode(result.stdout),
              stderr: result.stderr,
            })),
          ),
        ),
      ),
  };
  const verifyExpectedIdentity = (input: {
    readonly ref: Parameters<RuntimeProviderShape["locateVolume"]>[0];
    readonly expectedGeneration: string;
    readonly operation: "restoreVolume" | "removeVolume";
  }) =>
    request(options, input.operation, {
      method: "GET",
      path: `/volumes/${encodeURIComponent(volumeName(input.ref.store))}`,
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.try({
              try: () => JSON.parse(response.body) as EngineVolume,
              catch: (cause) =>
                volumeError(options, input.operation, "Provider volume inspection failed.", undefined, cause),
            })
          : Effect.fail(
              volumeError(options, input.operation, "Provider volume inspection failed.", response),
            ),
      ),
      Effect.flatMap((current) =>
        current.Name === volumeName(input.ref.store) &&
        current.Labels?.["dev.lando.volume-instance"] === input.expectedGeneration
          ? Effect.void
          : Effect.fail(
              volumeError(
                options,
                input.operation,
                "Provider volume generation changed before mutation.",
                undefined,
                undefined,
                input.ref.store,
              ),
            ),
      ),
    );
  return {
    locateVolume: (ref: Parameters<RuntimeProviderShape["locateVolume"]>[0]) =>
      locateVolume(observation, ref),
    observeVolume: (target: MountedVolumeTarget) => observeMountedVolume(observation, target),
    adoptVolume: (target: VolumeAdoptionTarget) => adoptMountedVolume(observation, target),
    run: (spec: EphemeralRunSpec): Effect.Effect<ExecResult, ProviderError, Scope.Scope> =>
      runBytes(options, { ...spec, captureStdout: spec.captureStdout ?? false }).pipe(
        Effect.map(({ exitCode, stdout, stderr }) => ({
          exitCode,
          stdout: textDecoder.decode(stdout),
          stderr,
        })),
      ),
    runStream: (spec: EphemeralRunSpec): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> =>
      runByteStream(options, spec),
    snapshotVolume: ((spec) => {
      const store = spec.volume.store;
      const name = volumeName(store);
      const id = spec.snapshotId ?? `${name}-snapshot-${randomUUID()}`;
      if (options.snapshotMode === "native") {
        return snapshotVolumeWithCommit(options, store, id).pipe(
          Effect.flatMap((snapshot) =>
            request(options, "snapshotVolume", {
              method: "GET",
              path: `/images/${encodeURIComponent(nativeSnapshotImage(id))}/json`,
            }).pipe(
              Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, store)),
              Effect.flatMap((response) =>
                Effect.try({
                  try: () => JSON.parse(response.body) as { readonly Id?: string; readonly Size?: number },
                  catch: (cause) =>
                    volumeError(
                      options,
                      "snapshotVolume",
                      "Provider native snapshot inspection failed.",
                      response,
                      cause,
                      store,
                    ),
                }),
              ),
              Effect.flatMap((image) =>
                image.Id === undefined || image.Size === undefined
                  ? Effect.fail(
                      volumeError(
                        options,
                        "snapshotVolume",
                        "Provider native snapshot identity was incomplete.",
                        image,
                        undefined,
                        store,
                      ),
                    )
                  : Effect.succeed({
                      ...snapshot,
                      digest: image.Id,
                      sizeBytes: image.Size,
                      format: "native" as const,
                    }),
              ),
            ),
          ),
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
      const snapshotStore = copyModeSnapshotStore(options.providerId);
      const snapshotFile = copyModeSnapshotFile(id);
      return runBytes(options, {
        image: copyModeHelperImage,
        command: [
          "sh",
          "-c",
          `set -eu; mkdir -p ${copyModeSnapshotMountPath}; file=${copyModeSnapshotMountPath}/${snapshotFile}; tar -C ${copyModeMountPath} -cf "$file" ${excludeWitness} .; digest="$(sha256sum "$file")"; set -- $digest; printf '%s %s\n' "$1" "$(wc -c < "$file")"`,
        ],
        mounts: [
          { store: name, target: copyModeMountTarget, readOnly: true },
          { store: snapshotStore, target: copyModeSnapshotMountTarget, readOnly: false },
        ],
        captureStdout: true,
        remove: true,
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? parseSnapshotMetrics(options, textDecoder.decode(result.stdout), "tar", store)
            : Effect.fail(
                volumeError(
                  options,
                  "snapshotVolume",
                  "Provider volume snapshot helper failed.",
                  result,
                  undefined,
                  store,
                ),
              ),
        ),
        Effect.map((metrics) => ({ provider: ProviderId.make(options.providerId), id, ...metrics })),
        Effect.mapError((cause) =>
          volumeError(options, "snapshotVolume", "Provider volume snapshot failed.", undefined, cause, store),
        ),
      );
    }) satisfies RuntimeProviderShape["snapshotVolume"],
    restoreVolume: ((spec) => {
      const store = spec.target.store;
      const name = volumeName(store);
      if (options.snapshotMode === "native") {
        const command =
          spec.overwrite !== false
            ? `test -d /snapshot && find /lando-data -mindepth 1 -maxdepth 1 ${preserveWitness} -exec rm -rf {} + && find /snapshot -mindepth 1 -maxdepth 1 ${preserveWitness} -exec sh -c 'cp -a -- "$@" /lando-data/' sh {} +`
            : "test -d /snapshot";
        const verifySource = request(options, "restoreVolume", {
          method: "GET",
          path: `/images/${encodeURIComponent(nativeSnapshotImage(spec.snapshot.id))}/json`,
        }).pipe(
          Effect.tap((response) => ensure2xx(options, "restoreVolume", response, store)),
          Effect.flatMap((response) =>
            Effect.try({
              try: () => JSON.parse(response.body) as { readonly Id?: string; readonly Size?: number },
              catch: (cause) =>
                volumeError(
                  options,
                  "restoreVolume",
                  "Provider native snapshot inspection failed.",
                  response,
                  cause,
                  store,
                ),
            }),
          ),
          Effect.flatMap((image) =>
            image.Id === spec.snapshot.digest && image.Size === spec.snapshot.sizeBytes
              ? Effect.void
              : Effect.fail(
                  volumeError(
                    options,
                    "restoreVolume",
                    "Provider native snapshot identity changed before mutation.",
                    image,
                    undefined,
                    store,
                  ),
                ),
          ),
        );
        return verifySource.pipe(
          Effect.zipRight(
            verifyExpectedIdentity({
              ref: spec.target,
              expectedGeneration: spec.expectedTargetGeneration,
              operation: "restoreVolume",
            }),
          ),
          Effect.zipRight(
            runBytes(options, {
              image: nativeSnapshotImage(spec.snapshot.id),
              command: ["sh", "-c", command],
              mounts: [{ store: name, target: copyModeMountTarget, readOnly: false }],
              remove: true,
            }),
          ),
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
      const snapshotStore = copyModeSnapshotStore(options.providerId);
      const snapshotFile = copyModeSnapshotFile(spec.snapshot.id);
      const snapshotPath = `${copyModeSnapshotMountPath}/${snapshotFile}`;
      const restoreCommand =
        spec.overwrite !== false
          ? `set -eu; test -f "$1"; actual="$(sha256sum "$1")"; actual="${"${actual%% *}"}"; test "$actual" = "$2"; test "$(wc -c < "$1")" = "$3"; find ${copyModeMountPath} -mindepth 1 -maxdepth 1 ${preserveWitness} -exec rm -rf {} +; tar -C ${copyModeMountPath} -xf "$1" ${excludeWitness}`
          : `set -eu; test -f "$1"; actual="$(sha256sum "$1")"; actual="${"${actual%% *}"}"; test "$actual" = "$2"; test "$(wc -c < "$1")" = "$3"`;
      return verifyExpectedIdentity({
        ref: spec.target,
        expectedGeneration: spec.expectedTargetGeneration,
        operation: "restoreVolume",
      }).pipe(
        Effect.zipRight(
          runBytes(options, {
            image: copyModeHelperImage,
            command: [
              "sh",
              "-c",
              restoreCommand,
              "lando-restore",
              snapshotPath,
              spec.snapshot.digest,
              String(spec.snapshot.sizeBytes),
            ],
            mounts: [
              { store: name, target: copyModeMountTarget, readOnly: false },
              { store: snapshotStore, target: copyModeSnapshotMountTarget, readOnly: true },
            ],
            remove: true,
          }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(
                volumeError(
                  options,
                  "restoreVolume",
                  "Provider volume restore helper failed or snapshot was not found.",
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
              : (JSON.parse(response.body) as
                  | EngineVolume[]
                  | { readonly Volumes?: ReadonlyArray<EngineVolume> });
          const volumes = Array.isArray(parsed) ? parsed : (parsed.Volumes ?? []);
          return volumes
            .map(
              (volume) =>
                volumeInfoFromEngineVolume(volume, filter) ??
                legacyVolumeInfoFromEngineVolume(volume, filter),
            )
            .filter((volume): volume is NonNullable<typeof volume> => volume !== undefined);
        }),
        Effect.mapError((cause) =>
          volumeError(options, "listVolumes", "Provider volume list failed.", undefined, cause, filter.store),
        ),
      )) satisfies RuntimeProviderShape["listVolumes"],
    removeVolume: ((ref, expectedGeneration) =>
      verifyExpectedIdentity({ ref, expectedGeneration, operation: "removeVolume" }).pipe(
        Effect.zipRight(
          request(options, "removeVolume", {
            method: "DELETE",
            path: `/volumes/${encodeURIComponent(volumeName(ref.store))}`,
          }),
        ),
        Effect.tap((response) => ensure2xx(options, "removeVolume", response, ref.store)),
        Effect.asVoid,
        Effect.mapError((cause) =>
          volumeError(options, "removeVolume", "Provider volume remove failed.", undefined, cause, ref.store),
        ),
      )) satisfies RuntimeProviderShape["removeVolume"],
    copyToService: ((target, spec) =>
      Effect.tryPromise({
        try: () => stat(spec.sourcePath),
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
        Effect.flatMap((sourceStat) => {
          const header = archiveFileHeader(basename(spec.targetPath), sourceStat.size);
          return header === undefined
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
            : Effect.succeed({ header, sourceSize: sourceStat.size });
        }),
        Effect.flatMap(({ header, sourceSize }) => {
          const source = Stream.fromAsyncIterable(
            (async function* () {
              let emitted = 0;
              for await (const chunk of Bun.file(spec.sourcePath).slice(0, sourceSize).stream()) {
                emitted += chunk.byteLength;
                yield chunk;
              }
              if (emitted !== sourceSize) throw new RangeError("Copy source changed size during upload.");
            })(),
            (cause) =>
              copyError(
                options,
                "copyToService",
                "Failed to read copy source.",
                { sourcePath: spec.sourcePath },
                cause,
                target.service,
              ),
          );
          const archive = Stream.concat(
            Stream.make(header),
            Stream.concat(
              source,
              Stream.make(new Uint8Array(padToBlock(sourceSize) - sourceSize + tarBlockSize * 2)),
            ),
          );
          return Effect.scoped(
            Stream.toAsyncIterableEffect(archive).pipe(
              Effect.flatMap((stdin) =>
                requireServiceContainerName(options, "copyToService", target).pipe(
                  Effect.flatMap((containerName) =>
                    request(options, "copyToService", {
                      method: "PUT",
                      path: `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(dirname(spec.targetPath))}&overwrite=${String(spec.overwrite ?? false)}`,
                      headers: { "Content-Type": "application/x-tar" },
                      stdin,
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
                ),
              ),
            ),
          );
        }),
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
      Stream.unwrapScoped(
        requireServiceContainerName(options, "copyFromService", target).pipe(
          Effect.flatMap((containerName) =>
            Stream.toAsyncIterableEffect(
              stream(options, "copyFromService", {
                method: "GET",
                path: `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(spec.sourcePath)}`,
              }),
            ).pipe(
              Effect.map((archive) =>
                Stream.fromAsyncIterable(extractFirstTarFile(archive), (cause) =>
                  copyError(
                    options,
                    "copyFromService",
                    "Failed to extract provider service copy archive.",
                    { sourcePath: spec.sourcePath },
                    cause,
                    target.service,
                  ),
                ),
              ),
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
      Effect.scoped(
        Stream.toAsyncIterableEffect(data).pipe(
          Effect.flatMap((stdin) =>
            request(options, "importArtifact", {
              method: "POST",
              path: "/images/load",
              headers: { "Content-Type": "application/x-tar" },
              stdin,
            }).pipe(
              Effect.mapError((cause) =>
                artifactError(
                  options,
                  "importArtifact",
                  "Provider artifact import failed.",
                  undefined,
                  cause,
                ),
              ),
            ),
          ),
        ),
      ).pipe(
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
        Effect.flatMap((response) => {
          const parsed = parseImportArtifactResponse(response.body);
          return parsed.ref === undefined
            ? Effect.fail(
                artifactError(
                  options,
                  "importArtifact",
                  "Provider artifact import did not return an image reference.",
                  response,
                ),
              )
            : Effect.succeed({
                providerId: ProviderId.make(options.providerId),
                ref: parsed.ref,
              });
        }),
      )) satisfies RuntimeProviderShape["importArtifact"],
  };
};

export type ProviderDataPlane = ReturnType<typeof makeProviderDataPlane>;
