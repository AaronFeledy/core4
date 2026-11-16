import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { redactProviderError } from "@lando/redaction/provider-error";
import type { Redactor } from "@lando/sdk/secrets";
import { requireBorrowableMounts } from "./borrowed-mounts.ts";
import { boundedDiagnostic, makeCompletionDiagnosticContext } from "./completion-diagnostic.ts";
import { removeRuntimeContainer } from "./container-removal.ts";
import type { EngineHttpRequest } from "./engine-api.ts";
import { tryParseJson } from "./engine-json.ts";
import {
  type VolumeHolder,
  ephemeralDataHelperLabels,
  isVolumeInUse,
  leftoverHelperRemediation,
  listVolumeHolders,
  volumeInUseMessage,
  volumeInUseRemediation,
} from "./ephemeral-data-helpers.ts";
import { ensureEphemeral2xx, runtimeRemediation } from "./ephemeral-http-failure.ts";
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
import { removeAllStaleVolumeHolders, sweepStaleDataHelpers } from "./stale-data-helpers.ts";
import { makeAttachDecoder } from "./streams.ts";
import { UstarHeaderError, encodeUstarHeader, padToBlock, TAR_BLOCK_SIZE as tarBlockSize } from "./tar.ts";
import { extractFirstTarFile } from "./tar-file-stream.ts";
import { ContainerTransportError } from "./transport-error.ts";
import {
  VOLUME_ARCHIVE_MOUNT,
  volumeArchiveDiscardStagingCommand,
  volumeArchiveDisposeCommand,
  volumeArchiveExportCommand,
  volumeArchiveExtractCommand,
  volumeArchivePublishCommand,
  volumeSnapshotCaptureCommand,
  volumeSnapshotExtractCommand,
} from "./volume-archive.ts";
import { VolumeArchiveGate } from "./volume-archive-gate.ts";
import { VOLUME_REPLACED_PREFIX } from "./volume-archive-reserved.ts";
import {
  type MountedVolumeTarget,
  type NativeVolumeIdentityResolution,
  type VolumeAdoptionTarget,
  adoptMountedVolume,
  locateVolume,
  observeMountedVolume,
  resolveNativeVolumeIdentity,
} from "./volume-observation.ts";
import { VOLUME_WITNESS_MOUNT } from "./volume-witness-helper.ts";

export {
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  volumeOwnershipLabels,
} from "./volume-ownership.ts";

import { volumeCreationLabels as makeVolumeCreationLabels } from "./volume-creation.ts";

export { dataHelperImage, sqliteHelperImage, volumeWitnessImage } from "./helper-images.ts";
export { volumeCreationFact, volumeCreationLabels } from "./volume-creation.ts";

import {
  annotateFailureRole,
  failureDefectCause,
  internalErrorRemediation,
  mapFailureCause,
  mapFailures,
  mapStreamFailures,
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
  type VolumeRef,
  type VolumeRestoreSpec,
  type VolumeSnapshotRef,
} from "@lando/sdk/schema";
import type {
  EphemeralRunSpec,
  ExecChunk,
  ExecResult,
  ProviderArtifactRef,
  ProviderError,
  RuntimeProviderShape,
  VolumeArchiveImportSpec,
} from "@lando/sdk/services";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Queue, type Scope, Stream } from "effect";

export interface DataPlaneHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly minimumApiVersion?: NonNullable<EngineHttpRequest["minimumApiVersion"]>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
  readonly onResponseHead?: () => void;
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
  readonly capabilities: Pick<ProviderCapabilities, "volumeSnapshot" | "volumeArchive">;
  readonly redactor: Redactor;
  readonly redactorFor?: (tokens: {
    readonly authoritativeTokens: readonly string[];
  }) => Effect.Effect<Redactor>;
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

const archiveMountTarget = PortablePath.make(VOLUME_ARCHIVE_MOUNT);
/** The volume mounted read-write where every archive helper script `cd`s. */
const archiveMount = (nativeName: string) => ({
  type: "volume" as const,
  store: nativeName,
  target: archiveMountTarget,
  readOnly: false,
});
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
    providerId: options.redactor.redactString(options.providerId),
    operation: options.redactor.redactString(operation),
    message: options.redactor.redactString(message),
    remediation: options.redactor.redactString(runtimeRemediation),
    ...(details === undefined ? {} : { details: redactDetails(details, options.redactor) }),
    ...(cause === undefined ? {} : { cause }),
    ...(store === undefined ? {} : { store: options.redactor.redactString(store) }),
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
    providerId: options.redactor.redactString(options.providerId),
    operation: options.redactor.redactString(operation),
    message: options.redactor.redactString(message),
    remediation: options.redactor.redactString(
      "Check that the source exists, the destination is writable, and the service is running. Run `lando doctor` to check the container runtime, then retry the copy.",
    ),
    ...(details === undefined ? {} : { details: redactDetails(details, options.redactor) }),
    ...(cause === undefined ? {} : { cause }),
    ...(service === undefined ? {} : { service: options.redactor.redactString(service) }),
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
    providerId: options.redactor.redactString(options.providerId),
    operation: options.redactor.redactString(operation),
    message: options.redactor.redactString(message),
    remediation: options.redactor.redactString(
      "Check that the image archive is valid and the container runtime has enough disk space. Run `lando doctor`, then retry the image transfer.",
    ),
    ...(details === undefined ? {} : { details: redactDetails(details, options.redactor) }),
    ...(cause === undefined ? {} : { cause }),
    ...(artifactRef === undefined ? {} : { artifactRef: options.redactor.redactString(artifactRef) }),
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
          "Lando couldn't copy files because the service has no applied app plan.",
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

const redactFailures = (redactor: Redactor) =>
  mapFailures((error: ProviderError) => redactProviderError(error, redactor));

const redactStreamFailures = (redactor: Redactor) =>
  mapStreamFailures((error: ProviderError) => redactProviderError(error, redactor));

const request = (options: ProviderDataPlaneOptions, operation: string, input: DataPlaneHttpRequest) =>
  options.api.request === undefined
    ? Effect.fail(missingDataPlaneClient(options, operation, "request"))
    : options.api.request(input).pipe(redactFailures(options.redactor));

const stream = (options: ProviderDataPlaneOptions, operation: string, input: DataPlaneHttpRequest) =>
  options.api.stream === undefined
    ? Stream.fail(missingDataPlaneClient(options, operation, "stream"))
    : options.api.stream(input).pipe(redactStreamFailures(options.redactor));

const missingDataPlaneClient = (
  options: ProviderDataPlaneOptions,
  operation: string,
  client: "request" | "stream",
) =>
  redactProviderError(
    new ProviderUnavailableError({
      providerId: options.providerId,
      operation,
      message: `Lando couldn't contact the container engine because its ${client} client is missing.`,
      remediation: internalErrorRemediation,
    }),
    options.redactor,
  );

const volumeActions = {
  snapshotVolume: "save the storage snapshot",
  "snapshotVolume.rollback": "remove the incomplete storage snapshot",
  restoreVolume: "restore the storage snapshot",
  removeVolume: "remove the storage volume",
  removeVolumeSnapshot: "remove the storage snapshot",
  listVolumes: "list storage volumes",
} as const;

const inspectionRemediation = `Run \`lando doctor\` to check the container runtime. If this persists, ${internalErrorRemediation}`;

const ensure2xx = (
  options: ProviderDataPlaneOptions,
  operation: keyof typeof volumeActions,
  response: DataPlaneHttpResponse,
  store?: string,
): Effect.Effect<void, VolumeOperationError> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(
        volumeError(
          options,
          operation,
          `The container engine couldn't ${volumeActions[operation]} (HTTP ${response.status}).`,
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
  if (pull === undefined) {
    return Effect.fail(
      redactProviderError(
        new ProviderUnavailableError({
          providerId: options.providerId,
          operation,
          message: "Lando couldn't prepare its helper image because the provider's image client is missing.",
          remediation: internalErrorRemediation,
          details: { reference: helper.ref },
        }),
        options.redactor,
      ),
    );
  }
  return pull(helper.ref).pipe(
    redactFailures(options.redactor),
    Effect.flatMap((pulled) =>
      pulled.digest === helper.digest
        ? Effect.void
        : Effect.fail(
            redactProviderError(
              new ProviderInternalError({
                providerId: options.providerId,
                operation,
                message:
                  "Lando refused to run its helper because the image doesn't match its verified digest.",
                remediation,
                details: {
                  reference: helper.ref,
                  expectedDigest: helper.digest,
                  ...(typeof pulled.digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(pulled.digest)
                    ? { actualDigest: pulled.digest }
                    : {}),
                },
              }),
              options.redactor,
            ),
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
      redactProviderError(
        new VolumeOperationError({
          providerId: options.providerId,
          operation: "run.volume",
          message:
            "Lando couldn't attach storage to its helper container because the app's ownership information is missing.",
          remediation: internalErrorRemediation,
          ...(owner === undefined ? {} : { details: { app: String(owner.app) } }),
          ...(mounts[0] === undefined ? {} : { store: mounts[0].store }),
        }),
        options.redactor,
      ),
    );
  }
  const stores = [...new Set(mounts.map((mount) => mount.store))];
  return Effect.forEach(stores, (name) => {
    const store = plan.stores.find((candidate) => candidate.name === name);
    if (store === undefined) {
      return Effect.fail(
        redactProviderError(
          new VolumeOperationError({
            providerId: options.providerId,
            operation: "run.volume",
            message: "Lando's helper requested storage that isn't declared by the app plan.",
            remediation: internalErrorRemediation,
            details: { app: plan.id, store: name },
            store: name,
          }),
          options.redactor,
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
          : ensureEphemeral2xx(options, spec, { operation: "run.volume", response }),
      ),
    );
  }).pipe(Effect.asVoid);
};

const staleSweepStarted = new WeakSet<ProviderDataPlaneOptions>();

const ensureStaleHelperSweep = (options: ProviderDataPlaneOptions): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (staleSweepStarted.has(options)) return Effect.void;
    staleSweepStarted.add(options);
    return sweepStaleDataHelpers(options.api.request, {
      providerId: options.providerId,
      redactor: options.redactor,
    });
  });

type WitnessMountSource = NonNullable<EphemeralRunSpec["mountsFrom"]>;

const createEphemeralContainer = Effect.fn("DataPlane.createEphemeralContainer")(function* (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
  witnessSource?: WitnessMountSource,
) {
  const source = spec.mountsFrom;
  // Podman drops VolumeOptions.Subpath when resolving VolumesFrom. Refuse before
  // create rather than silently exposing a volume root in place of its subpath.
  if (spec.mountsFrom !== undefined) {
    const inspected = yield* request(options, "run.mountsFrom", {
      method: "GET",
      path: `/containers/${encodeURIComponent(spec.mountsFrom.containerId)}/json`,
    });
    yield* ensureEphemeral2xx(options, spec, { operation: "run.mountsFrom", response: inspected });
    yield* requireBorrowableMounts(options.providerId, inspected.body);
  }
  const name = ephemeralContainerName(options.providerId);
  const compensate = (cause: Cause.Cause<ProviderError>) =>
    compensateFailedCreate(options, spec, name, cause);
  const mount = spec.mounts?.[0];
  const binds = (spec.mounts ?? []).flatMap((mount) =>
    mount.subpath !== undefined || requiresLongMountSyntax(mount.target)
      ? []
      : [`${volumeName(mount.store)}:${mount.target}${mount.readOnly ? ":ro" : ""}`],
  );
  const mounts = [
    ...(spec.mounts ?? []).flatMap((mount) =>
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
    ),
    ...(spec.binds ?? []).map((bind) => ({
      Type: "bind",
      Source: bind.source,
      Target: bind.target,
      ReadOnly: bind.readOnly === true,
    })),
  ];
  const attachStdin = spec.stdinStream !== undefined;
  yield* ensureStaleHelperSweep(options);
  const response = yield* request(options, "run.create", {
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
        ? {
            ...(spec.user === undefined ? {} : { User: spec.user }),
            ...(spec.entrypoint === undefined ? {} : { Entrypoint: spec.entrypoint }),
            HostConfig: {
              ...(spec.usernsMode === undefined ? {} : { UsernsMode: spec.usernsMode }),
              Binds: binds,
              ...(mounts.length === 0 ? {} : { Mounts: mounts }),
              ...(source === undefined
                ? {}
                : { VolumesFrom: [`${source.containerId}:${source.readOnly ? "ro" : "rw"}`] }),
            },
          }
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
  }).pipe(Effect.catchCause(compensate));
  const accepted = ensureEphemeral2xx(options, spec, { operation: "run.create", response });
  // 409: another container already holds this name, so it is not ours to remove.
  yield* response.status === 409 ? accepted : accepted.pipe(Effect.catchCause(compensate));
  return name;
});

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
    new ProviderInternalError({
      providerId: options.providerId,
      operation,
      message: `Lando's helper command exited with status ${outcome.exitCode}, and Lando couldn't remove its helper container.`,
      remediation: `Check the helper's error output in \`stderrTail\` for why it failed. ${leftoverHelperRemediation(options.redactor, true)}`,
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

const boundedEphemeralRemoval = (
  options: ProviderDataPlaneOptions,
  name: string,
  operation: string,
  cleanupRemediation: string,
) =>
  // Finalizers and masked acquire are uninterruptible. The removal stays
  // interruptible so this deadline can stop it; the caller stays masked so
  // parent cancellation waits for that bounded attempt instead of abandoning it.
  // The timeout runs the removal in its own fiber, so an interrupt already
  // pending on the caller does not cancel it before the DELETE is sent.
  Effect.interruptible(
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
        remediation: cleanupRemediation,
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
            message: `Lando timed out removing its helper container ${name}.`,
            remediation: cleanupRemediation,
          }),
        ),
    }),
    redactFailures(options.redactor),
  );

const compensateFailedCreate = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
  name: string,
  cause: Cause.Cause<ProviderError>,
): Effect.Effect<never, ProviderError> => {
  if (spec.remove === false) return Effect.failCause(cause);
  return boundedEphemeralRemoval(
    options,
    name,
    "run.create",
    leftoverHelperRemediation(options.redactor, false),
  ).pipe(
    Effect.matchCauseEffect({
      onSuccess: () => Effect.failCause(cause),
      onFailure: (cleanup) => Effect.failCause(mergeFailure(cause, cleanup, "cleanup")),
    }),
  );
};

const releaseEphemeralContainer = (release: EphemeralRelease) => {
  const { options, name, remove, exit, operation, observed } = release;
  if (!remove) return Effect.void;
  return boundedEphemeralRemoval(
    options,
    name,
    operation,
    leftoverHelperRemediation(options.redactor, Exit.isSuccess(exit)),
  ).pipe(
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
  }).pipe(Effect.tap((response) => ensureEphemeral2xx(options, spec, { operation: "run.wait", response })));

const inspectEphemeralExitCode = (options: ProviderDataPlaneOptions, name: string, spec: EphemeralRunSpec) =>
  request(options, "run.inspect", {
    method: "GET",
    path: `/containers/${encodeURIComponent(name)}/json`,
  }).pipe(
    Effect.tap((response) => ensureEphemeral2xx(options, spec, { operation: "run.inspect", response })),
    Effect.flatMap((response) =>
      tryParseJson(response.body, () =>
        redactProviderError(
          new ProviderInternalError({
            providerId: options.providerId,
            operation: "run.inspect",
            message:
              "Lando couldn't read the helper container's result because the container engine returned invalid data.",
            remediation: inspectionRemediation,
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
                message:
                  "Lando couldn't read the helper command's exit code from the container engine's result.",
                remediation: inspectionRemediation,
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
        yield* ensureEphemeral2xx(options, spec, { operation: "run.start", response: start });
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
          const attached = yield* Deferred.make<void, ProviderError>();
          const chunks = yield* Queue.bounded<ExecChunk, ProviderError | Cause.Done>(16);
          yield* Effect.addFinalizer(() => Queue.shutdown(chunks));
          yield* stream(options, "run.attach", {
            method: "POST",
            path: `/containers/${encodeURIComponent(name)}/attach?stream=true&stdin=${spec.stdinStream === undefined ? "false" : "true"}&stdout=true&stderr=true`,
            ...(spec.stdinStream === undefined ? {} : { stdin: spec.stdinStream }),
            onResponseHead: () => Deferred.doneUnsafe(attached, Effect.void),
          })
            .pipe((self) =>
              Stream.flattenIterable(
                Stream.map(self, (chunk) =>
                  decode(chunk).map((frame): ExecChunk => {
                    if (frame.stream === "stderr") diagnostic.write(frame.payload);
                    return { kind: frame.stream, chunk: new Uint8Array(frame.payload) };
                  }),
                ),
              ),
            )
            .pipe(
              Stream.runForEach((chunk) => Queue.offer(chunks, chunk)),
              Effect.andThen(Queue.end(chunks)),
              Effect.catchCause((cause) =>
                Deferred.failCause(attached, cause).pipe(Effect.andThen(Queue.failCause(chunks, cause))),
              ),
              Effect.forkScoped,
            );
          yield* Deferred.await(attached);
          const started = yield* request(options, "run.start", {
            method: "POST",
            path: `/containers/${encodeURIComponent(name)}/start`,
          });
          yield* ensureEphemeral2xx(options, spec, { operation: "run.start", response: started });
          const output = Stream.fromQueue(chunks);
          const completed = Stream.fromEffect(
            Effect.gen(function* () {
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
      command: volumeSnapshotCaptureCommand(),
      mounts: [archiveMount(volumeName(spec.store))],
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
        const parsed =
          wait.body.length === 0
            ? {}
            : yield* tryParseJson(wait.body, (cause) =>
                volumeError(
                  options,
                  "snapshotVolume",
                  "Lando couldn't read the storage snapshot helper's result.",
                  undefined,
                  cause,
                  spec.store,
                ),
              ).pipe(Effect.map((value) => value as { StatusCode?: number }));
        if (parsed.StatusCode !== undefined && parsed.StatusCode !== 0) {
          return yield* Effect.fail(
            volumeError(
              options,
              "snapshotVolume",
              "Lando's storage snapshot helper exited unsuccessfully.",
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

const stderrTailLimit = 8 * 1024;

const appendStderrTail = (current: string, chunk: Uint8Array): string => {
  const next = current + textDecoder.decode(chunk);
  return next.length > stderrTailLimit ? next.slice(-stderrTailLimit) : next;
};

type ArchivePhase = "extract" | "publish" | "dispose";

const freeSpaceRemediation =
  "Free disk space and retry: replacing a volume's contents needs room for a second copy of its data while Lando swaps the new data in.";

const archiveRemediation = (stderr: string): string =>
  /no space left on device/iu.test(stderr) ? freeSpaceRemediation : runtimeRemediation;

const helperFailureMessage: Readonly<Record<ArchivePhase, string>> = {
  extract: "Lando's volume archive helper exited unsuccessfully.",
  publish: "Lando stopped while swapping the volume's contents.",
  dispose: "Lando installed the volume's new contents but could not remove the previous copy.",
};

const unsupportedVolumeArchive = (options: ProviderDataPlaneOptions, operation: string) =>
  redactProviderError(
    new ProviderCapabilityError({
      providerId: options.providerId,
      operation,
      capability: "volumeArchive",
      requiredValue: "staged",
      actualValue: "unsupported",
      message: "This provider cannot stream or replace whole-volume archives.",
      remediation:
        "Use a provider with typed volume archive support, or move the data through a service path.",
    }),
    options.redactor,
  );

interface ArchiveFailureInput {
  readonly exitCode?: number | undefined;
  readonly stderr?: string | undefined;
  readonly store?: string | undefined;
  readonly cause?: unknown;
  readonly replaced?: string | undefined;
  readonly spaceHint?: boolean;
}

const phaseRemediation = (phase: ArchivePhase, stderr: string, input: ArchiveFailureInput): string => {
  const replacedIn = input.replaced === undefined ? "" : ` in ${input.replaced}`;
  switch (phase) {
    case "extract":
      return `${input.spaceHint === true ? `${freeSpaceRemediation} ` : ""}${archiveRemediation(stderr)}`;
    case "publish":
      return `${archiveRemediation(stderr)} The previous contents are retained${replacedIn}; the next import, restore, or snapshot of this volume finishes the swap.`;
    case "dispose":
      return `The new contents are installed. The previous copy${replacedIn} could not be removed; the next import, restore, or snapshot of this volume removes it. Do not repeat the restore.`;
  }
};

const archiveFailure = (
  options: ProviderDataPlaneOptions,
  operation: string,
  phase: ArchivePhase,
  message: string,
  input: ArchiveFailureInput = {},
) => {
  const stderr = input.stderr ?? "";
  const stderrTail =
    stderr.length === 0
      ? undefined
      : boundedDiagnostic(stderr, (value) => options.redactor.redactValue(value));
  return redactProviderError(
    new VolumeOperationError({
      providerId: options.providerId,
      operation,
      message,
      remediation: phaseRemediation(phase, stderr, input),
      ...(input.store === undefined ? {} : { store: input.store }),
      details: {
        phase,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(stderrTail === undefined ? {} : { stderrTail }),
        ...(input.replaced === undefined ? {} : { replaced: input.replaced }),
      },
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    }),
    options.redactor,
  );
};

const collectHelperOutcome = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
): Effect.Effect<{ readonly exitCode: number | undefined; readonly stderr: string }, ProviderError> =>
  Effect.scoped(
    Stream.runFold(
      runByteStream(options, spec),
      () => ({ exitCode: undefined as number | undefined, stderr: "" }),
      (state, chunk) => {
        if ("kind" in chunk) {
          return chunk.kind === "stderr"
            ? { exitCode: state.exitCode, stderr: appendStderrTail(state.stderr, chunk.chunk) }
            : state;
        }
        return { exitCode: chunk.exitCode, stderr: state.stderr };
      },
    ),
  );

/** One staged replacement of a volume's contents, keyed by its staging id. */
interface StagedArchive {
  readonly operation: string;
  readonly stagingId: string;
  readonly mount: ReturnType<typeof archiveMount>;
  readonly store: string;
}

const runArchiveHelper = (
  options: ProviderDataPlaneOptions,
  staged: StagedArchive,
  helper: { readonly phase: ArchivePhase; readonly command: readonly string[]; readonly replaced?: string },
) =>
  collectHelperOutcome(options, {
    image: dataHelperImage.ref,
    command: helper.command,
    mounts: [staged.mount],
    remove: true,
  }).pipe(
    Effect.flatMap((outcome) =>
      outcome.exitCode === 0
        ? Effect.void
        : Effect.fail(
            archiveFailure(options, staged.operation, helper.phase, helperFailureMessage[helper.phase], {
              exitCode: outcome.exitCode,
              stderr: outcome.stderr,
              store: staged.store,
              ...(helper.replaced === undefined ? {} : { replaced: helper.replaced }),
            }),
          ),
    ),
  );

const extractStagedArchive = <E, R>(
  options: ProviderDataPlaneOptions,
  staged: StagedArchive,
  archive: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<void, ProviderError | E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = (message: string, input: ArchiveFailureInput = {}) =>
        archiveFailure(options, staged.operation, "extract", message, { store: staged.store, ...input });
      const gate = new VolumeArchiveGate(`volume:${staged.store}`);
      const invalid = (cause: unknown) =>
        failure("Lando refused the volume archive because it is not a safe tar of the volume.", { cause });
      const validated = Stream.concat(
        archive.pipe(
          Stream.mapEffect((chunk) =>
            Effect.try({
              try: () => gate.push(chunk),
              catch: invalid,
            }),
          ),
          Stream.filter((chunk) => chunk.byteLength > 0),
        ),
        Stream.fromEffect(
          Effect.try({
            try: () => gate.finish(),
            catch: invalid,
          }),
        ).pipe(Stream.filter((chunk) => chunk.byteLength > 0)),
      );
      const queue = yield* Queue.bounded<Uint8Array, Cause.Done>(8);
      const producer = yield* Stream.runForEach(validated, (chunk) => Queue.offer(queue, chunk)).pipe(
        Effect.onExit(() => Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkScoped,
      );
      // Our own interruption of the producer is not a source failure; a real source
      // failure recorded before the extractor stopped still keeps its typed identity.
      const stopProducer = Effect.gen(function* () {
        yield* Fiber.interrupt(producer);
        const settled = yield* Fiber.await(producer).pipe(Effect.timeoutOption(Duration.seconds(5)));
        if (
          Option.isSome(settled) &&
          Exit.isFailure(settled.value) &&
          !Cause.hasInterruptsOnly(settled.value.cause)
        ) {
          return yield* Effect.failCause(settled.value.cause);
        }
      });
      const stdin = yield* Stream.toAsyncIterableEffect(Stream.fromQueue(queue));
      const outcome = yield* collectHelperOutcome(options, {
        image: dataHelperImage.ref,
        command: volumeArchiveExtractCommand(staged.stagingId),
        mounts: [staged.mount],
        remove: true,
        stdinStream: stdin,
      }).pipe(
        Effect.catch(
          (cause): Effect.Effect<never, ProviderError | E> =>
            cause instanceof ProviderUnavailableError && cause.cause instanceof ContainerTransportError
              ? stopProducer.pipe(
                  Effect.andThen(
                    Effect.fail(
                      failure(
                        "Lando's volume helper stopped while extracting the archive, so the volume's data is unchanged.",
                        { cause, spaceHint: true },
                      ),
                    ),
                  ),
                )
              : Effect.fail(cause),
        ),
      );
      if (outcome.exitCode !== 0) {
        yield* stopProducer;
        return yield* Effect.fail(
          failure("Lando's volume helper could not extract the archive, so the volume's data is unchanged.", {
            exitCode: outcome.exitCode,
            stderr: outcome.stderr,
          }),
        );
      }
      const sourceUnfinished = {
        duration: Duration.seconds(60),
        orElse: () =>
          Effect.fail(
            failure("Lando's volume archive source did not finish, so the volume's data is unchanged."),
          ),
      };
      // tar exits successfully at its end markers, possibly before the source is exhausted;
      // the source must still finish successfully or the import must not commit.
      yield* Stream.runDrain(Stream.fromQueue(queue)).pipe(Effect.timeoutOrElse(sourceUnfinished));
      const settled = yield* Fiber.await(producer).pipe(Effect.timeoutOrElse(sourceUnfinished));
      if (Exit.isFailure(settled)) return yield* Effect.failCause(settled.cause);
    }),
  ).pipe(Effect.asVoid);

/** Verify the helper image, publish staging uninterruptibly (the commit point), then dispose of the old copy. */
const commitStagedArchive = (
  options: ProviderDataPlaneOptions,
  staged: StagedArchive,
): Effect.Effect<void, ProviderError> => {
  const replaced = `${VOLUME_REPLACED_PREFIX}${staged.stagingId}`;
  return ensureHelperImage(options, staged.operation, dataHelperImage).pipe(
    Effect.andThen(
      Effect.uninterruptible(
        runArchiveHelper(options, staged, {
          phase: "publish",
          command: volumeArchivePublishCommand(staged.stagingId),
          replaced,
        }),
      ),
    ),
    Effect.andThen(
      runArchiveHelper(options, staged, {
        phase: "dispose",
        command: volumeArchiveDisposeCommand(staged.stagingId),
        replaced,
      }),
    ),
  );
};

/**
 * Run one staged replacement under a fresh staging id. Discarding this transaction's
 * staging is a best-effort finalizer; reconciliation removes anything it leaves.
 */
const withStagedArchive = <A, E, R>(
  options: ProviderDataPlaneOptions,
  target: Omit<StagedArchive, "stagingId">,
  use: (staged: StagedArchive) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync((): StagedArchive => ({ ...target, stagingId: randomUUID() })),
    use,
    (staged) =>
      runArchiveHelper(options, staged, {
        phase: "extract",
        command: volumeArchiveDiscardStagingCommand(staged.stagingId),
      }).pipe(
        Effect.timeoutOption(Duration.seconds(10)),
        Effect.catchCause(() => Effect.void),
        Effect.asVoid,
      ),
  );

export const makeProviderDataPlane = (input: ProviderDataPlaneOptions) => {
  // Each data-plane owns its sweep even when callers reuse the same options object.
  const options = { ...input };
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
              volumeError(
                options,
                input.operation,
                "Lando couldn't read the storage volume's identity.",
                undefined,
                cause,
              ),
            ).pipe(Effect.map((value) => value as EngineVolume))
          : Effect.fail(
              volumeError(
                options,
                input.operation,
                `The container engine couldn't inspect the storage volume (HTTP ${response.status}).`,
                response,
              ),
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
                "Lando stopped because the storage volume was replaced before it could be changed.",
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
    exportVolume: ((ref: VolumeRef): Stream.Stream<Uint8Array, ProviderError, Scope.Scope> =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            if (options.capabilities.volumeArchive !== true) {
              return yield* Effect.fail(unsupportedVolumeArchive(options, "exportVolume"));
            }
            const nativeName = volumeName(ref.store);
            yield* ensureHelperImage(options, "exportVolume", dataHelperImage);
            const stderr = { text: "" };
            return runByteStream(options, {
              image: dataHelperImage.ref,
              command: volumeArchiveExportCommand(),
              mounts: [archiveMount(nativeName)],
              remove: true,
            }).pipe(
              Stream.flatMap((chunk): Stream.Stream<Uint8Array, ProviderError> => {
                if ("kind" in chunk) {
                  if (chunk.kind === "stdout") return Stream.make(chunk.chunk);
                  stderr.text = appendStderrTail(stderr.text, chunk.chunk);
                  return Stream.empty;
                }
                return chunk.exitCode === 0
                  ? Stream.empty
                  : Stream.fail(
                      archiveFailure(options, "exportVolume", "extract", helperFailureMessage.extract, {
                        exitCode: chunk.exitCode,
                        stderr: stderr.text,
                        store: ref.store,
                      }),
                    );
              }),
            );
          }),
        ),
      )) satisfies RuntimeProviderShape["exportVolume"],
    importVolume: (<E, R>(
      spec: VolumeArchiveImportSpec<E, R>,
    ): Effect.Effect<void, ProviderError | E, Scope.Scope | R> =>
      Effect.scoped(
        Effect.gen(function* () {
          const operation = "importVolume";
          if (options.capabilities.volumeArchive !== true) {
            return yield* Effect.fail(unsupportedVolumeArchive(options, operation));
          }
          yield* ensureHelperImage(options, operation, dataHelperImage);
          yield* withStagedArchive(
            options,
            { operation, mount: archiveMount(volumeName(spec.target.store)), store: spec.target.store },
            (staged) =>
              Effect.gen(function* () {
                yield* extractStagedArchive(options, staged, spec.archive);
                yield* spec.beforeCommit;
                yield* commitStagedArchive(options, staged);
              }),
          );
        }),
      )) satisfies RuntimeProviderShape["importVolume"],
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
                  "Lando couldn't read the saved storage snapshot's identity.",
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
                      "The container engine returned an incomplete identity for the saved storage snapshot.",
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
    restoreVolume: (<E = never>(
      spec: VolumeRestoreSpec,
      callOptions?: { readonly beforeCommit?: Effect.Effect<void, E> },
    ): Effect.Effect<void, ProviderError | E, Scope.Scope> => {
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
      const snapshotImage = nativeSnapshotImage(spec.snapshot.id);
      const mount = archiveMount(name);
      const stagedRestore = (staged: StagedArchive): Effect.Effect<void, ProviderError | E> =>
        Effect.gen(function* () {
          const extraction = yield* collectHelperOutcome(options, {
            image: snapshotImage,
            command: volumeSnapshotExtractCommand(staged.stagingId),
            mounts: [mount],
            remove: true,
          });
          if (extraction.exitCode !== 0) {
            return yield* Effect.fail(
              archiveFailure(
                options,
                "restoreVolume",
                "extract",
                "Lando's snapshot helper could not stage the snapshot, so the volume's data is unchanged.",
                { exitCode: extraction.exitCode, stderr: extraction.stderr, store },
              ),
            );
          }
          yield* verifyExpectedIdentity({
            ref: spec.target,
            expectedGeneration: spec.expectedTargetGeneration,
            operation: "restoreVolume",
          });
          yield* callOptions?.beforeCommit ?? Effect.void;
          yield* commitStagedArchive(options, staged);
        });
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
              "Lando couldn't read the saved storage snapshot's identity.",
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
                  "Lando stopped because the saved storage snapshot changed before restoration.",
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
          spec.overwrite === false
            ? runBytes(options, {
                image: snapshotImage,
                command: ["sh", "-c", "test -d /snapshot"],
                mounts: [mount],
                remove: true,
              }).pipe(
                Effect.flatMap((result) =>
                  result.exitCode === 0
                    ? Effect.void
                    : Effect.fail(
                        volumeError(
                          options,
                          "restoreVolume",
                          "Lando's storage restore helper exited unsuccessfully.",
                          result,
                          undefined,
                          store,
                        ),
                      ),
                ),
              )
            : withStagedArchive(options, { operation: "restoreVolume", mount, store }, stagedRestore),
        ),
      );
    }) satisfies RuntimeProviderShape["restoreVolume"],
    listVolumes: ((filter) =>
      request(options, "listVolumes", { method: "GET", path: "/volumes" }).pipe(
        Effect.tap((response) => ensure2xx(options, "listVolumes", response, filter.store)),
        Effect.flatMap((response) =>
          response.body.length === 0
            ? Effect.succeed({ Volumes: [] })
            : tryParseJson(response.body, (cause) =>
                volumeError(
                  options,
                  "listVolumes",
                  "Lando couldn't read the container engine's storage volume list.",
                  undefined,
                  cause,
                  filter.store,
                ),
              ).pipe(
                Effect.map(
                  (value) => value as EngineVolume[] | { readonly Volumes?: ReadonlyArray<EngineVolume> },
                ),
              ),
        ),
        Effect.flatMap((parsed) => {
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
      )) satisfies RuntimeProviderShape["listVolumes"],
    removeVolume: ((ref, expectedGeneration) => {
      const volume = volumeName(ref.store);
      const deleteVolume = request(options, "removeVolume", {
        method: "DELETE",
        path: `/volumes/${encodeURIComponent(volume)}`,
      }).pipe(
        Effect.tap((response) => ensure2xx(options, "removeVolume", response, ref.store)),
        Effect.asVoid,
      );
      const volumeInUseFailure = (cause: Cause.Cause<ProviderError>, holders: ReadonlyArray<VolumeHolder>) =>
        Effect.failCause(
          mapFailureCause(cause, (error) => {
            if (!(error instanceof VolumeOperationError) || !isVolumeInUse(error.details)) return error;
            return new VolumeOperationError({
              providerId: options.providerId,
              operation: "removeVolume",
              store: ref.store,
              message: volumeInUseMessage(
                "The container engine couldn't remove the storage volume because it is in use.",
                holders,
                error.details,
                options.redactor,
              ),
              remediation: volumeInUseRemediation(options.redactor),
              details: redactDetails(error.details, options.redactor),
              cause: error,
            });
          }),
        );
      return verifyExpectedIdentity({ ref, expectedGeneration, operation: "removeVolume" }).pipe(
        Effect.andThen(deleteVolume),
        Effect.catchCause(
          Effect.fnUntraced(function* (cause) {
            const inUse = cause.reasons.some(
              (reason) =>
                Cause.isFailReason(reason) &&
                reason.error instanceof VolumeOperationError &&
                isVolumeInUse(reason.error.details),
            );
            if (!inUse) return yield* Effect.failCause(cause);
            const holders =
              options.api.request === undefined ? [] : yield* listVolumeHolders(options.api.request, volume);
            const recovered = yield* removeAllStaleVolumeHolders(options.api.request, {
              providerId: options.providerId,
              holders,
              redactor: options.redactor,
            });
            if (recovered) {
              return yield* deleteVolume.pipe(
                Effect.catchCause((retryCause) => {
                  const stillInUse = retryCause.reasons.some(
                    (reason) =>
                      Cause.isFailReason(reason) &&
                      reason.error instanceof VolumeOperationError &&
                      isVolumeInUse(reason.error.details),
                  );
                  if (!stillInUse) return Effect.failCause(retryCause);
                  return Effect.gen(function* () {
                    const remaining =
                      options.api.request === undefined
                        ? holders
                        : yield* listVolumeHolders(options.api.request, volume);
                    return yield* volumeInUseFailure(retryCause, remaining);
                  });
                }),
              );
            }
            return yield* volumeInUseFailure(cause, holders);
          }),
        ),
      );
    }) satisfies RuntimeProviderShape["removeVolume"],
    copyToService: ((target, spec) =>
      Effect.tryPromise({
        try: () => stat(spec.sourcePath),
        catch: (cause) =>
          copyError(
            options,
            "copyToService",
            "Lando couldn't read the file to copy into the service.",
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
                  "Lando couldn't package the source file for copying into the service.",
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
                "Lando couldn't read the file to copy into the service.",
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
                    }),
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
                  `The container engine couldn't copy the file into the service (HTTP ${response.status}).`,
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
          Effect.map((containerName) =>
            extractFirstTarFile(
              stream(options, "copyFromService", {
                method: "GET",
                path: `/containers/${encodeURIComponent(containerName)}/archive?path=${encodeURIComponent(spec.sourcePath)}`,
              }),
              (cause) =>
                copyError(
                  options,
                  "copyFromService",
                  "Lando couldn't extract the file returned by the service.",
                  { sourcePath: spec.sourcePath },
                  cause,
                  target.service,
                ),
            ),
          ),
        ),
      )) satisfies RuntimeProviderShape["copyFromService"],
    exportArtifact: ((ref: ProviderArtifactRef) =>
      stream(options, "exportArtifact", {
        method: "GET",
        path: `/images/${encodeURIComponent(ref.ref)}/get`,
      })) satisfies RuntimeProviderShape["exportArtifact"],
    importArtifact: ((data) =>
      Effect.scoped(
        Stream.toAsyncIterableEffect(data).pipe(
          Effect.flatMap((stdin) =>
            request(options, "importArtifact", {
              method: "POST",
              path: "/images/load",
              headers: { "Content-Type": "application/x-tar" },
              stdin,
            }),
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
                  `The container engine couldn't import the image archive (HTTP ${response.status}).`,
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
                  "The container engine didn't identify the image it imported.",
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
