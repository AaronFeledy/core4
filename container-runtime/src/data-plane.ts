import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { redactProviderError } from "@lando/redaction/provider-error";
import type { Redactor } from "@lando/sdk/secrets";
import { boundedDiagnostic, makeCompletionDiagnosticContext } from "./completion-diagnostic.ts";
import { removeRuntimeContainer } from "./container-removal.ts";
import { tryParseJson } from "./engine-json.ts";
import {
  ephemeralDataHelperLabels,
  isVolumeInUse,
  listVolumeHolders,
  volumeInUseMessage,
  volumeInUseRemediation,
} from "./ephemeral-data-helpers.ts";
import { type PinnedHelperImage, dataHelperImage, volumeWitnessImage } from "./helper-images.ts";
import type { PulledImage } from "./image-pull.ts";
import {
  APP_LABEL,
  PROVIDER_LABEL,
  SNAPSHOT_ID_LABEL,
  STORAGE_SCOPE_LABEL,
  STORE_LABEL,
  VOLUME_INSTANCE_LABEL,
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  VOLUME_SNAPSHOT_LABEL,
} from "./labels.ts";
import { requiresLongMountSyntax } from "./mount-syntax.ts";
import { serviceContainerName as namedServiceContainer } from "./plan.ts";
import { redactDetails } from "./redact.ts";
import { listNativeSnapshots } from "./snapshot-images.ts";
import { makeAttachDecoder } from "./streams.ts";
import { UstarHeaderError, encodeUstarHeader, padToBlock, TAR_BLOCK_SIZE as tarBlockSize } from "./tar.ts";
import {
  type MountedVolumeTarget,
  type NativeVolumeIdentityResolution,
  type VolumeAdoptionTarget,
  adoptMountedVolume,
  locateVolume,
  observeMountedVolume,
  resolveNativeVolumeIdentity,
} from "./volume-observation.ts";
import { VOLUME_WITNESS_FILE, VOLUME_WITNESS_MOUNT } from "./volume-witness-helper.ts";
export {
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  volumeOwnershipLabels,
} from "./volume-ownership.ts";
import { volumeCreationLabels as makeVolumeCreationLabels } from "./volume-creation.ts";
export { volumeCreationFact, volumeCreationLabels } from "./volume-creation.ts";
export { dataHelperImage, volumeWitnessImage } from "./helper-images.ts";

import { Cause, Duration, Effect, Exit, Fiber, type Scope, Stream } from "effect";

import {
  annotateFailureRole,
  failureDefectCause,
  mapFailureCause,
  mergeFailure,
} from "@lando/sdk/command-result";

import {
  ArtifactTransferError,
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceCopyError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import {
  AppId,
  type AppPlan,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  type ServiceName,
  type StorageScope,
  type VolumeInfo,
  type VolumeSnapshotRef,
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
  /**
   * Acquires a pinned helper image with the `missing` pull policy and reports
   * the digest it observed locally. The data plane refuses to create a helper
   * container unless that digest equals the pin.
   */
  readonly pullHelperImage?: (ref: string) => Effect.Effect<PulledImage, ProviderError>;
  readonly api: DataPlaneApiClient;
  readonly capabilities: Pick<ProviderCapabilities, "volumeSnapshot">;
  readonly redactor: Redactor;
  readonly volumeCreationLabels?: (
    plan: AppPlan,
    store: AppPlan["stores"][number],
  ) => Readonly<Record<string, string>>;
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

const archiveFileHeader = (name: string, payloadSize: number): Uint8Array | undefined => {
  try {
    return encodeUstarHeader({ name, size: payloadSize, mode: 0o644, typeflag: "0" });
  } catch (cause) {
    if (cause instanceof UstarHeaderError) return undefined;
    throw cause;
  }
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
  target.plan === undefined ? undefined : namedServiceContainer(target.plan, String(target.service));
const ephemeralContainerName = (providerId: string): string =>
  `lando-${sanitize(providerId)}-data-${randomUUID()}`;

const envList = (env: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> | undefined =>
  env === undefined ? undefined : Object.entries(env).map(([key, value]) => `${key}=${value}`);

const preserveWitness = `! -name '${VOLUME_WITNESS_FILE}' ! -name '.lando-witness-stage-*'`;
const snapshotDataMountTarget = PortablePath.make("/lando-data");
const nativeSnapshotRepo = "localhost/lando-volume-snapshot";

const nativeSnapshotImage = (id: string): string => `${nativeSnapshotRepo}:${sanitize(id).toLowerCase()}`;

const volumeError = (
  options: ProviderDataPlaneOptions,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  store?: string,
) => {
  const error = new VolumeOperationError({
    providerId: options.providerId,
    operation,
    message,
    remediation: "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
    ...(details === undefined
      ? {}
      : { details: operation.startsWith("run.") ? details : redactDetails(details, options.redactor) }),
    ...(cause === undefined ? {} : { cause }),
    ...(store === undefined ? {} : { store }),
  });
  return operation.startsWith("run.") ? redactProviderError(error, options.redactor) : error;
};

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
    ...(details === undefined ? {} : { details: redactDetails(details, options.redactor) }),
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
    ...(details === undefined ? {} : { details: redactDetails(details, options.redactor) }),
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
  readonly Driver?: string;
  readonly Options?: Readonly<Record<string, string>> | null;
  readonly Labels?: Readonly<Record<string, string>>;
  readonly CreatedAt?: string;
}

const landoVolumeLabels = {
  app: APP_LABEL,
  store: STORE_LABEL,
  scope: STORAGE_SCOPE_LABEL,
  instance: VOLUME_INSTANCE_LABEL,
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
    ? Effect.fail(missingDataPlaneClient(options, operation, "request"))
    : options.api
        .request(input)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.failCause(mapFailureCause(cause, (error) => redactProviderError(error, options.redactor))),
          ),
        );

const stream = (options: ProviderDataPlaneOptions, operation: string, input: DataPlaneHttpRequest) =>
  options.api.stream === undefined
    ? Stream.fail(missingDataPlaneClient(options, operation, "stream"))
    : options.api
        .stream(input)
        .pipe(
          Stream.catchCause((cause) =>
            Stream.failCause(mapFailureCause(cause, (error) => redactProviderError(error, options.redactor))),
          ),
        );

const missingDataPlaneClient = (
  options: ProviderDataPlaneOptions,
  operation: string,
  client: "request" | "stream",
) =>
  redactProviderError(
    new ProviderUnavailableError({
      providerId: options.providerId,
      operation,
      message: `Provider API ${client} client is missing.`,
      remediation:
        "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
    }),
    options.redactor,
  );

const ensure2xx = (
  options: ProviderDataPlaneOptions,
  operation: string,
  response: DataPlaneHttpResponse,
  store?: string,
): Effect.Effect<void, ProviderUnavailableError | VolumeOperationError> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : operation.startsWith("run.")
      ? Effect.fail(
          redactProviderError(
            new ProviderUnavailableError({
              providerId: options.providerId,
              operation,
              message: `Provider data-plane API returned HTTP ${response.status}.`,
              details: { status: response.status },
              remediation:
                "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
            }),
            options.redactor,
          ),
        )
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

/**
 * Acquire a pinned helper image and prove it is the pinned content before any
 * container is created from it. The provider's `missing` pull reuses a cached
 * image without a registry request; every other failure, and any digest other
 * than the pin, fails closed. There is no mutable-tag fallback.
 */
const ensureHelperImage = (
  options: ProviderDataPlaneOptions,
  operation: string,
  helper: PinnedHelperImage,
): Effect.Effect<void, ProviderError> => {
  const pull = options.pullHelperImage;
  const remediation =
    "Check network and registry access, then retry. Lando only runs data-plane helpers from pinned image digests; run `lando doctor` if the problem persists.";
  const fail = (message: string, details: Readonly<Record<string, unknown>>) =>
    redactProviderError(
      new ProviderInternalError({
        providerId: options.providerId,
        operation,
        message,
        remediation,
        details: redactDetails(details, options.redactor),
      }),
      options.redactor,
    );
  if (pull === undefined) {
    return Effect.fail(
      redactProviderError(
        new ProviderUnavailableError({
          providerId: options.providerId,
          operation,
          message: "Provider cannot acquire the pinned data-plane helper image.",
          remediation,
          details: { reference: helper.ref },
        }),
        options.redactor,
      ),
    );
  }
  return pull(helper.ref).pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(mapFailureCause(cause, (error) => redactProviderError(error, options.redactor))),
    ),
    Effect.flatMap((pulled) =>
      pulled.digest === helper.digest
        ? Effect.void
        : Effect.fail(
            fail("Pinned data-plane helper image digest did not match the pin.", {
              reference: helper.ref,
              expectedDigest: helper.digest,
            }),
          ),
    ),
  );
};

const ensureEphemeralVolumes = (options: ProviderDataPlaneOptions, spec: EphemeralRunSpec) => {
  const mounts = spec.mounts ?? [];
  if (mounts.length === 0) return Effect.void;
  const owner = spec.owner;
  const plan = owner?.plan;
  if (owner === undefined || plan === undefined || plan.identity === undefined || plan.id !== owner.app) {
    return Effect.fail(
      volumeError(
        options,
        "run.volume",
        "Provider ephemeral data-store mounts require an app plan with canonical ownership identity.",
        owner,
        undefined,
        mounts[0]?.store,
      ),
    );
  }
  const stores = [...new Set(mounts.map((mount) => mount.store))];
  return Effect.forEach(stores, (name) => {
    const store = plan.stores.find((candidate) => candidate.name === name);
    if (store === undefined) {
      return Effect.fail(
        volumeError(
          options,
          "run.volume",
          "Provider ephemeral data-store mount is not declared by the app plan.",
          { app: plan.id, store: name },
          undefined,
          name,
        ),
      );
    }
    const labels = (options.volumeCreationLabels ?? makeVolumeCreationLabels)(plan, store);
    return request(options, "run.volume", {
      method: "POST",
      path: "/volumes/create",
      body: { Name: store.name, Labels: labels },
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 200 || response.status === 201 || response.status === 409
          ? Effect.void
          : Effect.fail(
              redactProviderError(
                new ProviderUnavailableError({
                  providerId: options.providerId,
                  operation: "run.volume",
                  message: `Provider volume create returned HTTP ${response.status}.`,
                  details: { status: response.status },
                  remediation:
                    "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
                }),
                options.redactor,
              ),
            ),
      ),
    );
  }).pipe(Effect.asVoid);
};

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
  const mount = spec.mounts?.[0];
  const binds = (spec.mounts ?? []).flatMap((mount) =>
    mount.subpath !== undefined || requiresLongMountSyntax(mount.target)
      ? []
      : [`${volumeName(mount.store)}:${mount.target}${mount.readOnly ? ":ro" : ""}`],
  );
  const mounts = (spec.mounts ?? []).flatMap((mount) =>
    mount.subpath !== undefined || requiresLongMountSyntax(mount.target)
      ? [
          {
            Type: "volume",
            Source: volumeName(mount.store),
            Target: mount.target,
            ReadOnly: mount.readOnly,
            ...(mount.subpath === undefined ? {} : { VolumeOptions: { Subpath: mount.subpath } }),
          },
        ]
      : [],
  );
  const attachStdin = spec.stdinStream !== undefined;
  return request(options, "run.create", {
    method: "POST",
    path: `/containers/create?name=${encodeURIComponent(name)}`,
    body: {
      Image: spec.image,
      Cmd: spec.command,
      Labels: ephemeralDataHelperLabels({
        providerId: options.providerId,
        ...(spec.owner === undefined ? {} : { app: String(spec.owner.app) }),
        ...(spec.owner?.plan?.identity === undefined ? {} : { appRoot: spec.owner.plan.identity.appRoot }),
        ...(mount === undefined ? {} : { store: mount.store }),
      }),
      ...(envList(spec.env) === undefined ? {} : { Env: envList(spec.env) }),
      ...(witnessSource === undefined
        ? { HostConfig: { Binds: binds, ...(mounts.length === 0 ? {} : { Mounts: mounts }) } }
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

const commandOutcome = (
  value: unknown,
): { readonly exitCode: number; readonly stderr: string } | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("exitCode" in value) ||
    typeof value.exitCode !== "number"
  ) {
    return undefined;
  }
  const stderr = "stderr" in value && typeof value.stderr === "string" ? value.stderr : "";
  return { exitCode: value.exitCode, stderr };
};

const ephemeralCompletionFailure = (
  options: ProviderDataPlaneOptions,
  operation: string,
  outcome: { readonly exitCode: number; readonly stderr: string },
) => {
  const stderrTail = boundedDiagnostic(outcome.stderr, (value) => options.redactor.redactValue(value));
  return redactProviderError(
    new VolumeOperationError({
      providerId: options.providerId,
      operation,
      message: "Provider ephemeral command completed but container cleanup failed.",
      remediation:
        "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
      details:
        stderrTail === undefined
          ? { exitCode: outcome.exitCode }
          : { exitCode: outcome.exitCode, stderrTail },
    }),
    options.redactor,
  );
};

const completedCommandFailure = (
  exit: Exit.Exit<unknown, unknown>,
  observed: { readonly exitCode?: number; readonly stderr: string } | undefined,
): { readonly exitCode: number; readonly stderr: string } | undefined => {
  if (!Exit.isSuccess(exit)) return undefined;
  if (observed?.exitCode !== undefined) {
    return observed.exitCode === 0 ? undefined : { exitCode: observed.exitCode, stderr: observed.stderr };
  }
  const outcome = commandOutcome(exit.value);
  return outcome === undefined || outcome.exitCode === 0 ? undefined : outcome;
};

interface EphemeralRelease {
  readonly options: ProviderDataPlaneOptions;
  readonly name: string;
  readonly remove: boolean;
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly operation: string;
  readonly observed?: { readonly exitCode?: number; readonly stderr: string };
}

/** Fixed bound so a hung engine DELETE cannot hold scope close open. */
const EPHEMERAL_CLEANUP_DEADLINE = Duration.seconds(10);

const releaseEphemeralContainer = (release: EphemeralRelease) => {
  const { options, name, remove, exit, operation, observed } = release;
  if (!remove) return Effect.void;
  // Finalizers are uninterruptible. The removal stays interruptible so this
  // deadline can stop it; the finalizer stays masked so parent cancellation
  // still waits for that bounded attempt instead of abandoning cleanup.
  const removal = Effect.interruptible(
    removeRuntimeContainer(
      {
        request: (input) =>
          request(options, `${operation}.remove`, input).pipe(
            // Removal only uses the status. Do not promote an engine response body to diagnostics.
            Effect.map((response) => ({ ...response, body: "" })),
          ),
      },
      name,
      {
        providerId: options.providerId,
        operation: `${operation}.remove`,
        remediation:
          "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
        // The retained redactor was built from the host environment, so no env snapshot is needed here.
        env: {},
        redactor: options.redactor,
      },
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: EPHEMERAL_CLEANUP_DEADLINE,
      orElse: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: options.providerId,
            operation: `${operation}.remove`,
            message: "Provider ephemeral container cleanup timed out.",
            remediation:
              "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
          }),
        ),
    }),
    Effect.catchCause((cause) =>
      Effect.failCause(mapFailureCause(cause, (error) => redactProviderError(error, options.redactor))),
    ),
  );
  return removal.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => {
      const failedCommand = completedCommandFailure(exit, observed);
      const annotated =
        failedCommand === undefined
          ? annotateFailureRole(cause, "cleanup")
          : mergeFailure(
              Cause.fail(ephemeralCompletionFailure(options, operation, failedCommand)),
              cause,
              "cleanup",
            );
      return Effect.failCause(annotated);
    }),
  );
};

/** acquireRelease finalizers cannot fail in the typed channel; keep the tagged error as a defect. */
const defectCleanup = <E, R>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(Effect.catchCause((cause) => Effect.failCause(failureDefectCause(cause))));

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
          // The transport half-closes the upgraded connection once stdin is exhausted, which is
          // the container's EOF. Aborting here instead would race that flush and fail the attach.
          stdin,
        }),
      ).pipe(Effect.asVoid),
    (controller) => Effect.sync(() => controller.abort()),
  );
};

const waitForEphemeralContainer = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  request(options, "run.wait", {
    method: "POST",
    path: `/containers/${encodeURIComponent(name)}/wait`,
  }).pipe(Effect.tap((response) => ensure2xx(options, "run.wait", response, spec.mounts?.[0]?.store)));

const inspectEphemeralExitCode = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  request(options, "run.inspect", {
    method: "GET",
    path: `/containers/${encodeURIComponent(name)}/json`,
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "run.inspect", response, spec.mounts?.[0]?.store)),
    Effect.flatMap((response) =>
      tryParseJson(response.body, () =>
        redactProviderError(
          new ProviderInternalError({
            providerId: options.providerId,
            operation: "run.inspect",
            message: "Provider returned an invalid ephemeral command inspection.",
            remediation:
              "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
          }),
          options.redactor,
        ),
      ),
    ),
    Effect.flatMap((parsed) => {
      const state =
        typeof parsed === "object" && parsed !== null && "State" in parsed ? parsed.State : undefined;
      const exitCode =
        typeof state === "object" && state !== null && "ExitCode" in state ? state.ExitCode : undefined;
      return typeof exitCode === "number" && Number.isFinite(exitCode) && Number.isInteger(exitCode)
        ? Effect.succeed(exitCode)
        : Effect.fail(
            redactProviderError(
              new ProviderInternalError({
                providerId: options.providerId,
                operation: "run.inspect",
                message: "Provider did not return a valid ephemeral command exit code.",
                remediation:
                  "Retry the data-plane operation after checking provider runtime health with `lando doctor`.",
              }),
              options.redactor,
            ),
          );
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
        yield* ensure2xx(options, "run.start", start, spec.mounts?.[0]?.store);
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
      }),
    (name, exit) =>
      releaseEphemeralContainer({ options, name, remove: spec.remove !== false, exit, operation: "run" }),
  );

const runByteStream = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> => {
  const decode = makeAttachDecoder();
  const diagnostic = makeCompletionDiagnosticContext();
  // The stream fiber records the command outcome; the finalizer reads it after that fiber finishes.
  const observed: { exitCode?: number; readonly stderr: string } = {
    get stderr() {
      return diagnostic.text();
    },
  };
  return Stream.scoped(
    Stream.fromEffect(
      Effect.acquireRelease(
        createEphemeralContainer(options, { ...spec, captureStdout: true }),
        (name, exit) =>
          defectCleanup(
            releaseEphemeralContainer({
              options,
              name,
              remove: spec.remove !== false,
              exit,
              operation: "runStream",
              observed,
            }),
          ),
      ),
    ),
  ).pipe(
    Stream.flatMap((name) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stdinFiber = yield* Effect.forkScoped(attachEphemeralStdin(options, name, spec));
          const started = yield* request(options, "run.start", {
            method: "POST",
            path: `/containers/${encodeURIComponent(name)}/start`,
          });
          yield* ensure2xx(options, "run.start", started, spec.mounts?.[0]?.store);
          const output = stream(options, "run.logs", {
            method: "GET",
            path: `/containers/${encodeURIComponent(name)}/logs?follow=true&stdout=true&stderr=true`,
          }).pipe((self) =>
            Stream.flattenIterable(
              Stream.map(self, (chunk) =>
                decode(chunk).map((frame): ExecChunk => {
                  if (frame.stream === "stderr") diagnostic.write(frame.payload);
                  return { kind: frame.stream, chunk: new Uint8Array(frame.payload) };
                }),
              ),
            ),
          );
          const completed = Stream.fromEffect(
            Effect.gen(function* () {
              if (spec.stdinStream !== undefined) yield* Fiber.join(stdinFiber);
              yield* waitForEphemeralContainer(options, name, spec);
              const exitCode = yield* inspectEphemeralExitCode(options, name, spec);
              observed.exitCode = exitCode;
              return { exitCode } satisfies ExecChunk;
            }),
          );
          return Stream.concat(output, completed);
        }),
      ),
    ),
  );
};

const commitNativeSnapshot = (
  options: ProviderDataPlaneOptions,
  containerName: string,
  snapshotId: string,
  spec: { readonly store: string; readonly labels: Readonly<Record<string, string>> },
) => {
  const tag = sanitize(snapshotId).toLowerCase();
  return request(options, "snapshotVolume", {
    method: "POST",
    path: `/commit?container=${encodeURIComponent(containerName)}&repo=${encodeURIComponent(nativeSnapshotRepo)}&tag=${encodeURIComponent(tag)}`,
    body: { Labels: spec.labels },
  }).pipe(
    Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, spec.store)),
    Effect.as({ provider: ProviderId.make(options.providerId), id: snapshotId }),
  );
};

interface NativeSnapshotCommit {
  readonly store: string;
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly rollbackOnFailure: boolean;
}

const snapshotCommitHelper = (options: ProviderDataPlaneOptions, spec: NativeSnapshotCommit) =>
  Effect.acquireUseRelease(
    createEphemeralContainer(options, {
      image: dataHelperImage.ref,
      command: [
        "sh",
        "-c",
        `mkdir -p /snapshot && find /lando-data -mindepth 1 -maxdepth 1 ${preserveWitness} -exec sh -c 'cp -a -- "$@" /snapshot/' sh {} +`,
      ],
      mounts: [
        { type: "volume", store: volumeName(spec.store), target: snapshotDataMountTarget, readOnly: true },
      ],
      remove: true,
    }),
    (name) =>
      Effect.gen(function* () {
        const start = yield* request(options, "snapshotVolume", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/start`,
        });
        yield* ensure2xx(options, "snapshotVolume", start, spec.store);
        const wait = yield* request(options, "snapshotVolume", {
          method: "POST",
          path: `/containers/${encodeURIComponent(name)}/wait`,
        });
        yield* ensure2xx(options, "snapshotVolume", wait, spec.store);
        const parsed = wait.body.length === 0 ? {} : (JSON.parse(wait.body) as { StatusCode?: number });
        if (parsed.StatusCode !== undefined && parsed.StatusCode !== 0) {
          return yield* Effect.fail(
            volumeError(
              options,
              "snapshotVolume",
              "Provider volume snapshot helper failed.",
              wait,
              undefined,
              spec.store,
            ),
          );
        }
        if (spec.rollbackOnFailure) {
          // Register before issuing commit: interruption can hide a successful daemon-side commit.
          yield* Effect.addFinalizer((exit) =>
            Exit.match(exit, {
              onSuccess: () => Effect.void,
              onFailure: () =>
                request(options, "snapshotVolume.rollback", {
                  method: "DELETE",
                  path: `/images/${encodeURIComponent(nativeSnapshotImage(spec.id))}`,
                }).pipe(
                  Effect.flatMap((response) =>
                    response.status === 404
                      ? Effect.void
                      : ensure2xx(options, "snapshotVolume.rollback", response, spec.store),
                  ),
                  Effect.ignoreCause,
                ),
            }),
          );
        }
        return yield* commitNativeSnapshot(options, name, spec.id, spec);
      }),
    (name, exit) =>
      releaseEphemeralContainer({ options, name, remove: true, exit, operation: "snapshotVolume" }),
  );

const snapshotVolumeWithCommit = (options: ProviderDataPlaneOptions, spec: NativeSnapshotCommit) =>
  ensureHelperImage(options, "snapshotVolume", dataHelperImage).pipe(
    Effect.andThen(() => snapshotCommitHelper(options, spec)),
  );

export const makeProviderDataPlane = (options: ProviderDataPlaneOptions) => {
  const unsupportedSnapshot = (operation: string, format?: VolumeSnapshotRef["format"]) =>
    new ProviderCapabilityError({
      providerId: options.providerId,
      operation,
      capability: "volumeSnapshot",
      requiredValue: "native",
      actualValue:
        options.capabilities.volumeSnapshot === "native" ? format : options.capabilities.volumeSnapshot,
      message: "This provider data plane supports only native volume snapshots on native-capable providers.",
      remediation:
        "Use a provider with native snapshot support and a native snapshot reference, or use DataMover host archives.",
    });
  const executeWitness = (spec: EphemeralRunSpec, witnessSource?: WitnessMountSource) =>
    ensureHelperImage(options, "witness.image", volumeWitnessImage).pipe(
      Effect.andThen(() => Effect.scoped(runBytes(options, spec, witnessSource))),
      Effect.map((result) => ({
        exitCode: result.exitCode,
        stdout: textDecoder.decode(result.stdout),
        stderr: result.stderr,
      })),
    );
  const observation = {
    ...options,
    runWitness: (target: MountedVolumeTarget, command: readonly string[], readOnly: boolean) =>
      executeWitness(
        { image: volumeWitnessImage.ref, command, captureStdout: true, remove: true },
        { containerId: target.containerId, readOnly },
      ),
    runVolumeWitness: (nativeName: string, command: readonly string[]) =>
      executeWitness({
        image: volumeWitnessImage.ref,
        command,
        captureStdout: true,
        mounts: [
          {
            type: "volume",
            store: nativeName,
            target: PortablePath.make(VOLUME_WITNESS_MOUNT),
            readOnly: true,
          },
        ],
        remove: true,
      }),
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
          ? tryParseJson(response.body, (cause) =>
              volumeError(options, input.operation, "Provider volume inspection failed.", undefined, cause),
            ).pipe(Effect.map((value) => value as EngineVolume))
          : Effect.fail(
              volumeError(options, input.operation, "Provider volume inspection failed.", response),
            ),
      ),
      Effect.flatMap((current) =>
        current.Name === volumeName(input.ref.store)
          ? resolveNativeVolumeIdentity(
              observation,
              {
                Name: current.Name,
                ...(current.Driver === undefined ? {} : { Driver: current.Driver }),
                ...(current.Options === undefined ? {} : { Options: current.Options }),
                ...(current.Labels === undefined ? {} : { Labels: current.Labels }),
              },
              { _tag: "named" },
            )
          : Effect.succeed<NativeVolumeIdentityResolution>({}),
      ),
      Effect.flatMap((resolution) =>
        (resolution.identity?.generation ?? resolution.creationGeneration) === input.expectedGeneration
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
      ensureEphemeralVolumes(options, spec).pipe(
        Effect.andThen(
          Effect.suspend(() => runBytes(options, { ...spec, captureStdout: spec.captureStdout ?? false })),
        ),
        Effect.map(({ exitCode, stdout, stderr }) => ({
          exitCode,
          stdout: textDecoder.decode(stdout),
          stderr,
        })),
      ),
    runStream: (spec: EphemeralRunSpec): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> =>
      Stream.unwrap(
        ensureEphemeralVolumes(options, spec).pipe(Effect.map(() => runByteStream(options, spec))),
      ),
    snapshotVolume: ((spec): ReturnType<RuntimeProviderShape["snapshotVolume"]> => {
      const store = spec.volume.store;
      const name = volumeName(store);
      const id = spec.snapshotId ?? `${name}-snapshot-${randomUUID()}`;
      if (options.capabilities.volumeSnapshot !== "native") {
        return Effect.fail(unsupportedSnapshot("snapshotVolume"));
      }
      return snapshotVolumeWithCommit(options, {
        store,
        id,
        rollbackOnFailure: spec.snapshotId !== undefined,
        labels: {
          // Volume ownership labels prove a live volume's owner; they must never appear on an image.
          ...Object.fromEntries(
            Object.entries(spec.labels ?? {}).filter(
              ([key]) => key !== VOLUME_OWNER_LABEL && key !== VOLUME_SELECTOR_LABEL,
            ),
          ),
          [VOLUME_SNAPSHOT_LABEL]: "TRUE",
          [SNAPSHOT_ID_LABEL]: id,
          [APP_LABEL]: String(spec.volume.app),
          [STORE_LABEL]: store,
          [PROVIDER_LABEL]: options.providerId,
        },
      }).pipe(
        Effect.flatMap((snapshot) =>
          request(options, "snapshotVolume", {
            method: "GET",
            path: `/images/${encodeURIComponent(nativeSnapshotImage(id))}/json`,
          }).pipe(
            Effect.tap((response) => ensure2xx(options, "snapshotVolume", response, store)),
            Effect.flatMap((response) =>
              tryParseJson(response.body, (cause) =>
                volumeError(
                  options,
                  "snapshotVolume",
                  "Provider native snapshot inspection failed.",
                  response,
                  cause,
                  store,
                ),
              ).pipe(Effect.map((value) => value as { readonly Id?: string; readonly Size?: number })),
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
          volumeError(options, "snapshotVolume", "Provider volume snapshot failed.", undefined, cause, store),
        ),
        Effect.scoped,
      );
    }) satisfies RuntimeProviderShape["snapshotVolume"],
    listVolumeSnapshots: () => listNativeSnapshots(options),
    removeVolumeSnapshot: Effect.fn("ProviderDataPlane.removeVolumeSnapshot")(function* (
      snapshot: VolumeSnapshotRef,
      _options?: Parameters<RuntimeProviderShape["removeVolumeSnapshot"]>[1],
    ): Effect.fn.Return<void, ProviderError, Scope.Scope> {
      if (options.capabilities.volumeSnapshot !== "native") {
        return yield* Effect.fail(unsupportedSnapshot("removeVolumeSnapshot"));
      }
      if (snapshot.provider !== options.providerId) {
        return yield* Effect.fail(
          new VolumeOperationError({
            providerId: options.providerId,
            operation: "removeVolumeSnapshot",
            message: "Snapshot belongs to a different provider.",
            remediation: `Remove this snapshot with provider ${snapshot.provider}.`,
          }),
        );
      }
      switch (snapshot.format) {
        case "native": {
          const response = yield* request(options, "removeVolumeSnapshot", {
            method: "DELETE",
            path: `/images/${encodeURIComponent(nativeSnapshotImage(snapshot.id))}`,
          });
          if (response.status !== 404) yield* ensure2xx(options, "removeVolumeSnapshot", response);
          return;
        }
        case "tar": {
          return yield* Effect.fail(unsupportedSnapshot("removeVolumeSnapshot", snapshot.format));
        }
        default: {
          const unreachable: never = snapshot.format;
          return unreachable;
        }
      }
    }),
    restoreVolume: ((spec): ReturnType<RuntimeProviderShape["restoreVolume"]> => {
      const store = spec.target.store;
      const name = volumeName(store);
      if (options.capabilities.volumeSnapshot !== "native" || spec.snapshot.format !== "native") {
        return Effect.fail(unsupportedSnapshot("restoreVolume", spec.snapshot.format));
      }
      if (spec.snapshot.provider !== options.providerId) {
        return Effect.fail(
          new VolumeOperationError({
            providerId: options.providerId,
            operation: "restoreVolume",
            message: "Snapshot belongs to a different provider.",
            remediation: `Restore this snapshot with provider ${spec.snapshot.provider}.`,
          }),
        );
      }
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
          tryParseJson(response.body, (cause) =>
            volumeError(
              options,
              "restoreVolume",
              "Provider native snapshot inspection failed.",
              response,
              cause,
              store,
            ),
          ).pipe(Effect.map((value) => value as { readonly Id?: string; readonly Size?: number })),
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
        Effect.andThen(
          verifyExpectedIdentity({
            ref: spec.target,
            expectedGeneration: spec.expectedTargetGeneration,
            operation: "restoreVolume",
          }),
        ),
        Effect.andThen(
          runBytes(options, {
            image: nativeSnapshotImage(spec.snapshot.id),
            command: ["sh", "-c", command],
            mounts: [{ type: "volume", store: name, target: snapshotDataMountTarget, readOnly: false }],
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
    }) satisfies RuntimeProviderShape["restoreVolume"],
    listVolumes: ((filter) =>
      request(options, "listVolumes", { method: "GET", path: "/volumes" }).pipe(
        Effect.tap((response) => ensure2xx(options, "listVolumes", response, filter.store)),
        Effect.flatMap((response) => {
          const parsed =
            response.body.length === 0
              ? { Volumes: [] }
              : (JSON.parse(response.body) as
                  | EngineVolume[]
                  | { readonly Volumes?: ReadonlyArray<EngineVolume> });
          const volumes = Array.isArray(parsed) ? parsed : (parsed.Volumes ?? []);
          return Effect.forEach(volumes, (volume) => {
            const info =
              volumeInfoFromEngineVolume(volume, filter) ?? legacyVolumeInfoFromEngineVolume(volume, filter);
            if (info === undefined || volume.Name === undefined) return Effect.succeed(info);
            const exact = filter.app !== undefined && filter.store !== undefined;
            return resolveNativeVolumeIdentity(
              observation,
              {
                Name: volume.Name,
                ...(volume.Driver === undefined ? {} : { Driver: volume.Driver }),
                ...(volume.Options === undefined ? {} : { Options: volume.Options }),
                ...(volume.Labels === undefined ? {} : { Labels: volume.Labels }),
              },
              exact ? { _tag: "named" } : undefined,
            ).pipe(
              Effect.map((resolution) =>
                resolution.identity === undefined ? info : { ...info, identity: resolution.identity },
              ),
            );
          }).pipe(
            Effect.map((resolved) =>
              resolved.filter((volume): volume is NonNullable<typeof volume> => volume !== undefined),
            ),
          );
        }),
        Effect.mapError((cause) =>
          volumeError(options, "listVolumes", "Provider volume list failed.", undefined, cause, filter.store),
        ),
      )) satisfies RuntimeProviderShape["listVolumes"],
    removeVolume: ((ref, expectedGeneration) =>
      verifyExpectedIdentity({ ref, expectedGeneration, operation: "removeVolume" }).pipe(
        Effect.andThen(
          request(options, "removeVolume", {
            method: "DELETE",
            path: `/volumes/${encodeURIComponent(volumeName(ref.store))}`,
          }),
        ),
        Effect.tap((response) => ensure2xx(options, "removeVolume", response, ref.store)),
        Effect.asVoid,
        Effect.catch(
          Effect.fnUntraced(function* (cause) {
            const details = cause instanceof VolumeOperationError ? cause.details : undefined;
            if (isVolumeInUse(details)) {
              const holders =
                options.api.request === undefined
                  ? []
                  : yield* listVolumeHolders(options.api.request, volumeName(ref.store));
              return yield* Effect.fail(
                new VolumeOperationError({
                  providerId: options.providerId,
                  operation: "removeVolume",
                  store: ref.store,
                  message: volumeInUseMessage(
                    "Provider volume remove failed.",
                    holders,
                    details,
                    options.redactor,
                  ),
                  remediation: volumeInUseRemediation(options.redactor),
                  details: redactDetails(details, options.redactor),
                  cause,
                }),
              );
            }
            return yield* Effect.fail(
              volumeError(
                options,
                "removeVolume",
                "Provider volume remove failed.",
                undefined,
                cause,
                ref.store,
              ),
            );
          }),
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
            Stream.concat(source, Stream.make(new Uint8Array(padToBlock(sourceSize) + tarBlockSize * 2))),
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
      Stream.unwrap(
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
