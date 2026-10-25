import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_ROOT_LABEL, SNAPSHOT_STORE_LABEL } from "@lando/container-runtime/labels";
import { providerImages } from "@lando/container-runtime/provider-images";
import { sha256Hex } from "@lando/sdk/digest";

import {
  Cause,
  Clock,
  type Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";

import { findAppRoot } from "@lando/landofile/discovery";
import { isPathWithin } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import {
  ArchiveFormatError,
  ArtifactTransferError,
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  DataTransferError,
  ProviderUnavailableError,
  SnapshotOwnershipError,
  errnoCode,
} from "@lando/sdk/errors";
import {
  DataTransferProgressEvent,
  type LandoEvent,
  PostDataTransferEvent,
  PostVolumeSnapshotEvent,
  PreDataTransferEvent,
  PreVolumeSnapshotEvent,
} from "@lando/sdk/events";
import {
  AbsolutePath,
  type DataEndpoint,
  type DataTransferProgress,
  type DataTransferResult,
  type DataTransferSpec,
  PortablePath,
  ProviderId,
  type PrunePolicy,
  type SnapshotInfo,
  type VolumeSnapshotRef,
  snapshotHandle,
} from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import {
  VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";
import { findRealpathAncestor, resolveStatePath } from "@lando/state-store/paths";
import { decodeArchiveStream, encodeArchiveStream } from "./archive-stream.ts";
import { checkedTransferCommand, serviceCommandFailure } from "./command-failure.ts";
import { execStdoutStream } from "./exec-stream.ts";
import { legacySnapshotReferences, orphanedSnapshotMethods } from "./orphaned-snapshots.ts";
import {
  type SnapshotPersistence,
  findSnapshotInfo,
  listSnapshotInfos,
  openSnapshot,
  removeSnapshotArchive,
  resolveSnapshotInfo,
} from "./snapshot-catalog.ts";
import {
  matchesSnapshotSource,
  physicalVolumeGeneration,
  requireSnapshotTargetOwner,
  snapshotSourceOwner,
} from "./snapshot-owner.ts";
import { snapshotArchivePath, stateFailure } from "./snapshot-paths.ts";
import { removeCatalogSnapshot } from "./snapshot-removal.ts";
import { requireSnapshotSeedTarget } from "./snapshot-seed.ts";
import { stageVerifiedStream } from "./staged-stream.ts";
import { sharedVolumeInitialization } from "./volume-initialization.ts";

interface DataMoverEvents {
  readonly redactText: (text: string) => string;
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

type DataMoverTransferError =
  | ArchiveFormatError
  | DataTransferError
  | DataEndpointUnsupportedError
  | DataChecksumMismatchError
  | DataTargetExistsError;

const noopEvents: DataMoverEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

const helperTarget = Schema.decodeUnknownSync(PortablePath)("/data");
const helperPayload = Schema.decodeUnknownSync(PortablePath)("/data/payload");

const absolutePath = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const providerId = (id: string) => Schema.decodeUnknownSync(ProviderId)(id);

const endpointName = (endpoint: DataEndpoint): string => {
  switch (endpoint._tag) {
    case "hostPath":
      return `hostPath:${endpoint.path}`;
    case "hostArchive":
      return `hostArchive:${endpoint.format}:${endpoint.path}`;
    case "stream":
      return "stream";
    case "volume":
      return `volume:${endpoint.app}:${endpoint.store}`;
    case "servicePath":
      return `servicePath:${endpoint.app}:${endpoint.service}:${endpoint.path}`;
    case "serviceCmd":
      return `serviceCmd:${endpoint.app}:${endpoint.service}`;
    case "artifact":
      return `artifact:${endpoint.ref}`;
  }
};

const appFromEndpoint = (endpoint: DataEndpoint) => {
  switch (endpoint._tag) {
    case "volume":
    case "servicePath":
    case "serviceCmd":
      return endpoint.app;
    default:
      return undefined;
  }
};

const serviceFromEndpoint = (endpoint: DataEndpoint) =>
  endpoint._tag === "servicePath" || endpoint._tag === "serviceCmd" ? endpoint.service : undefined;

const makeEvents = (
  eventService: Option.Option<Context.Service.Shape<typeof EventService>>,
  redaction: Option.Option<Context.Service.Shape<typeof RedactionService>>,
): Effect.Effect<DataMoverEvents> => {
  const publish: DataMoverEvents["publish"] = Option.isSome(eventService)
    ? (event) => eventService.value.publish(event).pipe(Effect.catchCause(() => Effect.void))
    : () => Effect.void;

  if (Option.isNone(redaction)) return Effect.succeed({ ...noopEvents, publish });

  return redaction.value.forProfile("secrets").pipe(
    Effect.map((redactor) => ({ redactText: redactor.redactString, publish })),
    Effect.catch(() => Effect.succeed({ ...noopEvents, publish })),
  );
};

const unsupported = (from: DataEndpoint, to: DataEndpoint, reason: string): DataEndpointUnsupportedError =>
  new DataEndpointUnsupportedError({
    message: `Data transfer from ${from._tag} to ${to._tag} is not supported: ${reason}.`,
    fromEndpoint: endpointName(from),
    toEndpoint: endpointName(to),
    remediation:
      "Use a provider with the matching data-plane capability or choose a different endpoint pair.",
  });

const failUnsupported = (from: DataEndpoint, to: DataEndpoint, reason: string) =>
  Effect.fail(unsupported(from, to, reason));

const providerFailure = (operation: string, cause: unknown): DataTransferError =>
  new DataTransferError({
    message: `Provider ${operation} failed during data transfer.`,
    operation,
    cause,
    remediation: "Inspect provider diagnostics and retry after the runtime is healthy.",
  });

const dataHelperImage = providerImages.images.dataHelper;

const resolveDataHelperImage = (
  provider: Context.Service.Shape<typeof RuntimeProvider>,
): Effect.Effect<string, DataTransferError> => {
  const pinnedRef = `${dataHelperImage.image}@${dataHelperImage.digest}`;
  if (!provider.capabilities.artifactPull) return Effect.succeed(pinnedRef);
  return provider.pullArtifact({ ref: pinnedRef, policy: "missing" }).pipe(
    Effect.mapError((cause) => providerFailure("pullArtifact", cause)),
    Effect.flatMap((ref) => {
      if (ref.digest !== dataHelperImage.digest) {
        return Effect.fail(
          new DataTransferError({
            message: "Pinned data-helper image digest could not be verified.",
            operation: "resolve-helper-image",
            cause: { expectedDigest: dataHelperImage.digest, actualDigest: ref.digest },
            remediation:
              "The provider returned a different image digest than the pinned manifest; refuse to run an unverified helper image.",
          }),
        );
      }
      return Effect.succeed(pinnedRef);
    }),
  );
};

const octal = (value: number, width: number): string => {
  const text = value.toString(8);
  if (text.length > width - 1) {
    throw new ArchiveFormatError({
      message: "Archive payload is too large for the portable tar header.",
      format: "tar",
      remediation: "Use a smaller payload or a provider-native data transfer path.",
    });
  }
  return text.padStart(width - 1, "0");
};

const MAX_DECOMPRESSED_ARCHIVE_BYTES = 2 * 1024 ** 3;

export const __testOnlyEncodeTarOctal = octal;

const parseOctal = (bytes: Uint8Array): number => {
  const text = new TextDecoder().decode(bytes).replaceAll("\0", "").trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) return Number.NaN;
  return Number.parseInt(text, 8);
};

const unpackTar = (archive: Uint8Array, path: string): Uint8Array => {
  if (archive.byteLength < 512) {
    throw new ArchiveFormatError({
      message: "Archive is too small to contain a tar header.",
      format: "tar",
      archivePath: path,
      remediation: "Use a valid tar archive produced by DataMover.",
    });
  }
  const size = parseOctal(archive.slice(124, 136));
  if (!Number.isSafeInteger(size)) {
    throw new ArchiveFormatError({
      message: "Archive payload size is not a valid tar octal value.",
      format: "tar",
      archivePath: path,
      remediation: "Recreate the archive and retry the transfer.",
    });
  }
  const start = 512;
  const end = start + size;
  if (end > archive.byteLength) {
    throw new ArchiveFormatError({
      message: "Archive payload is truncated.",
      format: "tar",
      archivePath: path,
      remediation: "Recreate the archive and retry the transfer.",
    });
  }
  return archive.slice(start, end);
};

interface CappedWebStreamBytesInput {
  readonly stream: ReadableStream<Uint8Array>;
  readonly maxBytes: number;
  readonly format: "tar.gz" | "tar.zst";
  readonly path: string;
}

const webStreamBytesCapped = async (input: CappedWebStreamBytesInput): Promise<Uint8Array> => {
  const reader = input.stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const output = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return output;
      }
      totalBytes += value.byteLength;
      if (totalBytes > input.maxBytes) {
        await reader.cancel();
        throw new ArchiveFormatError({
          message: `Archive decompressed size exceeded ${input.maxBytes} bytes for ${input.format}.`,
          format: input.format,
          archivePath: input.path,
          remediation: "Recreate or transfer a smaller archive.",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
};

const compressionFormat = (format: "tar.gz" | "tar.zst") => (format === "tar.gz" ? "gzip" : "zstd");

interface UnarchivePayloadInput {
  readonly payload: Uint8Array;
  readonly format: "tar" | "tar.gz" | "tar.zst";
  readonly path: string;
  readonly maxDecompressedBytes: number;
}

const unarchivePayloadWithCap = (
  input: UnarchivePayloadInput,
): Effect.Effect<Uint8Array, ArchiveFormatError> => {
  const { format, path, payload } = input;
  switch (format) {
    case "tar":
      // Uncompressed tar has no decompression amplification; allocation is bounded by on-disk size and header/truncation checks.
      return Effect.try({
        try: () => unpackTar(payload, path),
        catch: (cause) =>
          cause instanceof ArchiveFormatError
            ? cause
            : new ArchiveFormatError({
                message: "Failed to decode host archive endpoint.",
                format,
                archivePath: path,
                cause,
              }),
      });
    case "tar.gz":
    case "tar.zst":
      return Effect.tryPromise({
        try: async () =>
          unpackTar(
            await webStreamBytesCapped({
              stream: new Blob([payload])
                .stream()
                .pipeThrough(new DecompressionStream(compressionFormat(format))),
              maxBytes: input.maxDecompressedBytes,
              format,
              path,
            }),
            path,
          ),
        catch: (cause) =>
          cause instanceof ArchiveFormatError
            ? cause
            : new ArchiveFormatError({
                message: "Failed to decode host archive endpoint.",
                format,
                archivePath: path,
                cause,
              }),
      });
  }
};

export const __testOnlyUnarchivePayloadWithCap = unarchivePayloadWithCap;

const providerCommandSpec = (
  command: string | ReadonlyArray<string>,
  env: Readonly<Record<string, string>> | undefined,
): { readonly command: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> } => ({
  command: typeof command === "string" ? ["sh", "-lc", command] : command,
  ...(env === undefined ? {} : { env }),
});

const mapVerifiedError = (error: VerifiedStreamError, spec: DataTransferSpec) => {
  if (error.reason === "checksum") {
    return new DataChecksumMismatchError({
      message: "Data transfer checksum did not match the expected SHA-256.",
      expectedSha256: error.expectedSha256 ?? spec.expectedDigest ?? "",
      actualSha256: error.actualSha256 ?? "",
      archivePath: spec.to._tag === "hostArchive" ? spec.to.path : undefined,
      remediation: "Retry the transfer from a trusted source; verification cannot be skipped.",
    });
  }

  return new DataTransferError({
    message: error.message,
    fromEndpoint: endpointName(spec.from),
    toEndpoint: endpointName(spec.to),
    operation: "persist",
    remediation: "Verify the destination path is writable and retry the transfer.",
    cause: error,
  });
};

const realpathNearestExisting = async (path: string): Promise<string> => {
  const found = await findRealpathAncestor(path, (candidate) => realpath(candidate).catch(() => null));
  if (found === null) throw new Error(`No existing ancestor for ${path}`);
  return found.realAncestor;
};

const snapshotStoreIdentity = (persistence: SnapshotPersistence) =>
  resolveStatePath(
    { path: absolutePath(persistence.paths.snapshotsDir) },
    undefined,
    "snapshot-identity",
    "canonicalize",
  ).pipe(
    Effect.map(({ rootReal }) => sha256Hex(rootReal)),
    Effect.mapError((cause) => stateFailure("canonicalize", cause)),
  );

const resolveAppRoot = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
  const cwdRoot = yield* findAppRoot(process.cwd());
  if (cwdRoot !== undefined) return cwdRoot;

  for (const path of paths) {
    const endpointRoot = yield* findAppRoot(path);
    if (endpointRoot !== undefined) return endpointRoot;
  }

  return process.cwd();
});

const ensureInsideRoot = Effect.fnUntraced(function* (path: string, root: string) {
  const normalized = resolve(path);
  if (!isPathWithin(root, normalized)) {
    return yield* Effect.fail(
      new DataSourceOutsideRootError({
        message: "Host data endpoint escapes the permitted app root.",
        path,
        base: root,
        remediation: "Move the source/destination inside the app root or use an explicitly trusted endpoint.",
      }),
    );
  }
  const existing = yield* Effect.tryPromise({
    try: () => realpathNearestExisting(normalized),
    catch: () =>
      new DataSourceOutsideRootError({
        message: "Failed to resolve host data endpoint.",
        path,
        base: root,
        remediation: "Use a host endpoint with an existing ancestor inside the app root.",
      }),
  });
  if (isPathWithin(root, existing)) return;
  return yield* Effect.fail(
    new DataSourceOutsideRootError({
      message: "Host data endpoint escapes the permitted app root.",
      path,
      base: root,
      remediation: "Move the source/destination inside the app root or use an explicitly trusted endpoint.",
    }),
  );
});

const lexicallyInside = (path: string, base: string): boolean => isPathWithin(base, resolve(path));

const ensureInsideScratch = Effect.fnUntraced(function* (path: string, scratchDir: string) {
  const configuredBase = resolve(scratchDir);
  const realBase = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await realpath(scratchDir);
      } catch {
        return configuredBase;
      }
    },
    catch: () =>
      new DataSourceOutsideRootError({
        message: "Failed to resolve the scratch storage root for data endpoint validation.",
        path: scratchDir,
      }),
  });
  const escapes = new DataSourceOutsideRootError({
    message: "Host data endpoint escapes the permitted scratch storage root.",
    path,
    base: configuredBase,
    remediation: "Scratch materialization may only target the Lando-owned scratch storage root.",
  });
  if (!lexicallyInside(path, configuredBase) && !lexicallyInside(path, realBase))
    return yield* Effect.fail(escapes);
  const existing = yield* Effect.tryPromise({
    try: () => realpathNearestExisting(resolve(path)),
    catch: () => escapes,
  });
  if (!lexicallyInside(existing, realBase) && !lexicallyInside(realBase, existing))
    return yield* Effect.fail(escapes);
});

const validateHostEndpoints = Effect.fnUntraced(function* (spec: DataTransferSpec, scratchDir: string) {
  const scratchHostCopy =
    spec.from._tag === "hostPath" &&
    spec.to._tag === "hostPath" &&
    lexicallyInside(spec.to.path, resolve(scratchDir))
      ? { from: spec.from, to: spec.to }
      : undefined;
  if (scratchHostCopy !== undefined) {
    const appRoot = yield* resolveAppRoot([scratchHostCopy.from.path]);
    const root = yield* Effect.tryPromise({
      try: () => realpath(appRoot),
      catch: () =>
        new DataSourceOutsideRootError({
          message: "Failed to resolve the app root for data endpoint validation.",
          path: scratchHostCopy.from.path,
        }),
    });
    yield* ensureInsideRoot(scratchHostCopy.from.path, root);
    yield* ensureInsideScratch(scratchHostCopy.to.path, scratchDir);
    return;
  }
  const endpoints = [spec.from, spec.to].filter(
    (endpoint): endpoint is Extract<DataEndpoint, { readonly _tag: "hostPath" | "hostArchive" }> =>
      endpoint._tag === "hostPath" || endpoint._tag === "hostArchive",
  );
  if (endpoints.length === 0) return;
  const appRoot = yield* resolveAppRoot(endpoints.map((endpoint) => endpoint.path));
  const root = yield* Effect.tryPromise({
    try: () => realpath(appRoot),
    catch: () =>
      new DataSourceOutsideRootError({
        message: "Failed to resolve the app root for data endpoint validation.",
        path: endpoints[0]?.path ?? process.cwd(),
      }),
  });
  yield* Effect.all(
    endpoints.map((endpoint) =>
      endpoint === spec.from && endpoint._tag === "hostPath" && endpoint.trusted === true
        ? Effect.void
        : ensureInsideRoot(endpoint.path, root),
    ),
    { discard: true },
  );
});

const reflinkCopyTree = async (source: string, destination: string): Promise<boolean> => {
  // Kernel/ABI semantics are intentional: WSL reports linux and supports this cp capability probe.
  if (process.platform !== "linux") return false;
  try {
    const proc = Bun.spawn(["cp", "-a", "--reflink=auto", `${source}/.`, destination], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
};

const directorySizeBytes = async (root: string): Promise<number> => {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        total += (await stat(entryPath)).size;
      }
    }
  };
  await walk(root);
  return total;
};

const copyHostTree = (
  source: string,
  destination: string,
): Effect.Effect<DataTransferResult, DataTransferError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(destination, { recursive: true });
      if (!(await reflinkCopyTree(source, destination))) {
        await cp(source, destination, { recursive: true, dereference: false, force: true });
      }
      return { accelerated: true, sizeBytes: await directorySizeBytes(destination) };
    },
    catch: (cause) =>
      new DataTransferError({
        message: "Failed to copy host directory tree.",
        fromEndpoint: `hostPath:${source}`,
        toEndpoint: `hostPath:${destination}`,
        operation: "copy-host-tree",
        cause,
        remediation: "Verify the source path is readable and the destination is writable, then retry.",
      }),
  });

const hostSourceIsDirectory = (path: string): Effect.Effect<boolean, DataTransferError> =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: (cause) =>
      new DataTransferError({
        message: "Failed to inspect host source endpoint.",
        fromEndpoint: `hostPath:${path}`,
        operation: "stat-host",
        cause,
      }),
  }).pipe(Effect.map((info) => info.isDirectory()));

const hostReadError = (path: string, cause: unknown): DataTransferError => {
  const code = errnoCode(cause);
  const missing = code === "ENOENT";
  const denied = code === "EACCES" || code === "EPERM";
  return new DataTransferError({
    message: missing
      ? `Host data file not found: ${path}`
      : denied
        ? `Host data file is not readable: ${path}`
        : "Failed to read host data endpoint.",
    fromEndpoint: `hostPath:${path}`,
    operation: "read-host",
    cause,
    remediation: "Check that the host path exists and is readable.",
  });
};

const byteStreamFromHost = (path: string): Stream.Stream<Uint8Array, DataTransferError> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.try({
        try: () => Bun.file(path).stream().getReader(),
        catch: (cause) => hostReadError(path, cause),
      }),
      (reader) => Effect.sync(() => reader.releaseLock()),
    ).pipe(
      Effect.map((reader) =>
        Stream.fromEffectRepeat(
          Effect.tryPromise({
            try: () => reader.read(),
            catch: (cause) => hostReadError(path, cause),
          }).pipe(Effect.flatMap((result) => (result.done ? Cause.done() : Effect.succeed(result.value)))),
        ),
      ),
    ),
  );

const byteStreamFromArchive = (
  path: string,
  format: "tar" | "tar.gz" | "tar.zst",
): Stream.Stream<Uint8Array, DataTransferError | ArchiveFormatError> =>
  decodeArchiveStream({
    body: byteStreamFromHost(path),
    format,
    path,
    maxPayloadBytes: MAX_DECOMPRESSED_ARCHIVE_BYTES,
  });

type DataProvider = Effect.Effect<Context.Service.Shape<typeof RuntimeProvider>, DataTransferError>;

const streamFromEndpoint = (
  selectedProvider: DataProvider,
  endpoint: DataEndpoint,
): Stream.Stream<
  Uint8Array,
  ArchiveFormatError | DataTransferError | DataEndpointUnsupportedError,
  Scope.Scope
> => {
  switch (endpoint._tag) {
    case "hostPath":
      return byteStreamFromHost(endpoint.path);
    case "hostArchive":
      return byteStreamFromArchive(endpoint.path, endpoint.format);
    default:
      return Stream.unwrap(
        Effect.map(selectedProvider, (provider) => streamFromProvider(provider, endpoint)),
      );
  }
};

const streamFromProvider = (
  provider: Context.Service.Shape<typeof RuntimeProvider>,
  endpoint: Exclude<DataEndpoint, { readonly _tag: "hostPath" | "hostArchive" }>,
): Stream.Stream<
  Uint8Array,
  ArchiveFormatError | DataTransferError | DataEndpointUnsupportedError,
  Scope.Scope
> => {
  switch (endpoint._tag) {
    case "servicePath":
      if (provider.capabilities.serviceFileCopy !== "native") {
        return Stream.fail(
          new DataEndpointUnsupportedError({
            message: "Service path export requires native service file copy support.",
            fromEndpoint: endpointName(endpoint),
            toEndpoint: "stream",
            remediation: "Use a provider with native service file copy support.",
          }),
        );
      }
      return provider
        .copyFromService({ app: endpoint.app, service: endpoint.service }, { sourcePath: endpoint.path })
        .pipe(Stream.mapError((cause) => providerFailure("copyFromService", cause)));
    case "volume":
      if (!provider.capabilities.ephemeralMounts) {
        return Stream.fail(
          new DataEndpointUnsupportedError({
            message: "Volume export requires ephemeral mounts for the generic fallback.",
            fromEndpoint: endpointName(endpoint),
            toEndpoint: "stream",
            remediation: "Use a provider with ephemeral mount support or a native data-plane method.",
          }),
        );
      }
      return Stream.unwrap(
        resolveDataHelperImage(provider).pipe(
          Effect.map((image) =>
            execStdoutStream(
              provider.runStream({
                owner: { app: endpoint.app },
                image,
                command: ["sh", "-c", `cat ${helperPayload}`],
                mounts: [{ store: endpoint.store, target: helperTarget, readOnly: true }],
                remove: true,
              }),
              (exitCode, stderrTail) => serviceCommandFailure("runStream", exitCode, stderrTail),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof DataTransferError ? cause : providerFailure("runStream", cause),
          ),
        ),
      );
    case "artifact":
      if (!provider.capabilities.artifactExport) {
        return Stream.fail(
          new DataEndpointUnsupportedError({
            message: "Artifact export is not supported by the active provider.",
            fromEndpoint: endpointName(endpoint),
            toEndpoint: "stream",
            remediation: "Use a provider with artifact export support.",
          }),
        );
      }
      return provider
        .exportArtifact({ providerId: providerId(provider.id), ref: endpoint.ref })
        .pipe(Stream.mapError((cause) => providerFailure("exportArtifact", cause)));
    case "serviceCmd":
      return execStdoutStream(
        provider.execStream(
          { app: endpoint.app, service: endpoint.service },
          providerCommandSpec(endpoint.command, endpoint.env),
        ),
        (exitCode, stderrTail) => serviceCommandFailure("execStream", exitCode, stderrTail),
        endpoint.env,
      );
    case "stream":
      return Stream.fail(
        new DataEndpointUnsupportedError({
          message: `Endpoint ${endpoint._tag} cannot be used as an implicit transfer source.`,
          fromEndpoint: endpointName(endpoint),
          toEndpoint: "stream",
          remediation: "Use an explicit host, service path, volume, or artifact source.",
        }),
      );
  }
};

const writeStreamToEndpoint = Effect.fnUntraced(function* (
  selectedProvider: DataProvider,
  spec: DataTransferSpec,
  body: Stream.Stream<
    Uint8Array,
    ArchiveFormatError | DataTransferError | DataEndpointUnsupportedError,
    Scope.Scope
  >,
  scratchDir: string,
): Effect.fn.Return<DataTransferResult, DataMoverTransferError, Scope.Scope> {
  const target = spec.to;
  switch (target._tag) {
    case "hostPath": {
      const result = yield* persistVerifiedStream({
        body,
        destinationPath: target.path,
        expectedSha256: spec.expectedDigest,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      return { accelerated: false, sizeBytes: result.sizeBytes, digest: result.sha256 };
    }
    case "hostArchive": {
      const staged = yield* stageVerifiedStream({
        body,
        scratchDir,
        prefix: "archive",
        ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
      }).pipe(
        Effect.mapError((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      yield* persistVerifiedStream({
        body: encodeArchiveStream({
          body: byteStreamFromHost(staged.path),
          sizeBytes: staged.verified.sizeBytes,
          format: target.format,
          path: target.path,
        }),
        destinationPath: target.path,
      }).pipe(
        Effect.mapError((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      return {
        accelerated: false,
        sizeBytes: staged.verified.sizeBytes,
        digest: staged.verified.sha256,
      };
    }
    case "servicePath": {
      const provider = yield* selectedProvider;
      if (provider.capabilities.serviceFileCopy !== "native")
        return yield* failUnsupported(spec.from, target, "native service file copy is unavailable");
      {
        const staged = yield* stageVerifiedStream({
          body,
          scratchDir,
          prefix: "service",
          ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
        }).pipe(
          Effect.mapError((error) =>
            error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
          ),
        );
        yield* provider
          .copyToService(
            { app: target.app, service: target.service },
            {
              sourcePath: absolutePath(staged.path),
              targetPath: target.path,
              ...(spec.overwrite === undefined ? {} : { overwrite: spec.overwrite }),
            },
          )
          .pipe(Effect.mapError((cause) => providerFailure("copyToService", cause)));
        return {
          accelerated: true,
          sizeBytes: staged.verified.sizeBytes,
          digest: staged.verified.sha256,
        };
      }
    }
    case "volume": {
      const provider = yield* selectedProvider;
      if (!provider.capabilities.ephemeralMounts)
        return yield* failUnsupported(spec.from, target, "ephemeral mounts are unavailable");
      {
        if (spec.overwrite !== true) {
          const volumes = yield* provider.listVolumes({ app: target.app, store: target.store }).pipe(
            Effect.catchIf(
              (cause) => cause instanceof ProviderUnavailableError,
              () => Effect.succeed([]),
            ),
            Effect.mapError((cause) => providerFailure("listVolumes", cause)),
          );
          if (volumes.some((volume) => volume.ref.app === target.app && volume.ref.store === target.store)) {
            return yield* Effect.fail(
              new DataTargetExistsError({
                message: "Target volume already exists and overwrite was not requested.",
                store: target.store,
                app: target.app,
                remediation: "Pass overwrite:true only after confirming the existing data can be replaced.",
              }),
            );
          }
        }
        const staged = yield* stageVerifiedStream({
          body,
          scratchDir,
          prefix: "volume",
          ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
        }).pipe(
          Effect.mapError((error) =>
            error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
          ),
        );
        const helperImage = yield* resolveDataHelperImage(provider);
        yield* checkedTransferCommand(
          provider.run({
            owner: { app: target.app },
            image: helperImage,
            command: ["sh", "-c", `cat > ${helperPayload}`],
            mounts: [{ store: target.store, target: helperTarget, readOnly: false }],
            stdinStream: Bun.file(staged.path).stream(),
            remove: true,
          }),
          "run",
        );
        return {
          accelerated: false,
          sizeBytes: staged.verified.sizeBytes,
          digest: staged.verified.sha256,
        };
      }
    }
    case "artifact": {
      const provider = yield* selectedProvider;
      if (!provider.capabilities.artifactImport)
        return yield* failUnsupported(spec.from, target, "artifact import is unavailable");
      {
        const staged = yield* stageVerifiedStream({
          body,
          scratchDir,
          prefix: "artifact",
          ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
        }).pipe(
          Effect.mapError((error) =>
            error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
          ),
        );
        yield* provider
          .importArtifact(
            byteStreamFromHost(staged.path).pipe(
              Stream.mapError(
                (cause) =>
                  new ArtifactTransferError({
                    providerId: provider.id,
                    operation: "importArtifact",
                    message: "Failed to read the staged artifact payload.",
                    cause,
                    remediation: "Retry the transfer after checking available scratch storage.",
                  }),
              ),
            ),
          )
          .pipe(Effect.mapError((cause) => providerFailure("importArtifact", cause)));
        return {
          accelerated: true,
          sizeBytes: staged.verified.sizeBytes,
          digest: staged.verified.sha256,
        };
      }
    }
    case "serviceCmd": {
      const provider = yield* selectedProvider;
      const staged = yield* stageVerifiedStream({
        body,
        scratchDir,
        prefix: "command",
        ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
      }).pipe(
        Effect.mapError((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      const stdinStream = Bun.file(staged.path).stream();
      yield* checkedTransferCommand(
        provider.exec(
          { app: target.app, service: target.service },
          {
            ...providerCommandSpec(target.command, target.env),
            stdinStream,
          },
        ),
        "exec",
        target.env,
      );
      return {
        accelerated: true,
        sizeBytes: staged.verified.sizeBytes,
        digest: staged.verified.sha256,
      };
    }
    case "stream":
      return yield* failUnsupported(
        spec.from,
        target,
        `endpoint ${target._tag} cannot be used as an implicit transfer target`,
      );
  }
});

const failureDetail = (cause: Cause.Cause<unknown>): string => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (typeof failure === "object" && failure !== null && "_tag" in failure)
    return String((failure as { _tag: string })._tag);
  if (Cause.hasInterrupts(cause)) return "interrupted";
  return "error";
};

export const makeDataMoverService = (
  selectedProvider: DataProvider,
  events: DataMoverEvents,
  persistence: SnapshotPersistence,
): Context.Service.Shape<typeof DataMover> =>
  DataMover.of({
    volumeInitialization: Effect.fn("DataMover.volumeInitialization")((identity) =>
      sharedVolumeInitialization(persistence.stateStore, identity),
    ),
    transfer: Effect.fn("DataMover.transfer")(function* (spec) {
      const startedAt = yield* Clock.currentTimeMillis;
      const fromEndpoint = events.redactText(endpointName(spec.from));
      const toEndpoint = events.redactText(endpointName(spec.to));
      const app = appFromEndpoint(spec.from) ?? appFromEndpoint(spec.to);
      const service = serviceFromEndpoint(spec.from) ?? serviceFromEndpoint(spec.to);
      const pre = PreDataTransferEvent.make({
        eventName: "pre-data-transfer",
        fromEndpoint,
        toEndpoint,
        ...(app === undefined ? {} : { app }),
        ...(service === undefined ? {} : { service }),
        timestamp: yield* DateTime.now,
      });

      const run = Effect.gen(function* () {
        yield* validateHostEndpoints(spec, persistence.paths.scratchDir);
        const hostToHost = spec.from._tag === "hostPath" && spec.to._tag === "hostPath";
        const treeCopy = hostToHost ? yield* hostSourceIsDirectory(spec.from.path) : false;
        if (treeCopy && spec.from._tag === "hostPath" && spec.to._tag === "hostPath") {
          const treeResult = yield* copyHostTree(spec.from.path, spec.to.path);
          yield* events.publish(
            DataTransferProgressEvent.make({
              eventName: "data-transfer-progress",
              fromEndpoint,
              toEndpoint,
              transferredBytes: treeResult.sizeBytes ?? 0,
              timestamp: yield* DateTime.now,
            }),
          );
          return treeResult;
        }
        const serviceCopy =
          (spec.from._tag === "hostPath" && spec.to._tag === "servicePath") ||
          (spec.from._tag === "servicePath" &&
            (spec.to._tag === "hostPath" || spec.to._tag === "hostArchive"));
        const nativeServiceCopy =
          serviceCopy && (yield* selectedProvider).capabilities.serviceFileCopy === "native";
        const body = streamFromEndpoint(selectedProvider, spec.from);
        const result = yield* writeStreamToEndpoint(
          selectedProvider,
          spec,
          body,
          persistence.paths.scratchDir,
        );
        const adjusted = nativeServiceCopy ? { ...result, accelerated: true } : result;
        const progress: DataTransferProgress = {
          phase: "completed",
          transferredBytes: adjusted.sizeBytes ?? 0,
          ...(adjusted.digest === undefined ? {} : { digest: adjusted.digest }),
        };
        yield* events.publish(
          DataTransferProgressEvent.make({
            eventName: "data-transfer-progress",
            fromEndpoint,
            toEndpoint,
            transferredBytes: progress.transferredBytes,
            ...(progress.digest === undefined ? {} : { digest: progress.digest }),
            timestamp: yield* DateTime.now,
          }),
        );
        return adjusted;
      });

      return yield* events.publish(pre).pipe(
        Effect.andThen(run),
        Effect.tap(
          Effect.fnUntraced(function* (result) {
            yield* events.publish(
              PostDataTransferEvent.make({
                eventName: "post-data-transfer",
                fromEndpoint,
                toEndpoint,
                outcome: "success",
                accelerated: result.accelerated,
                ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
                ...(result.digest === undefined ? {} : { digest: result.digest }),
                durationMs: (yield* Clock.currentTimeMillis) - startedAt,
                timestamp: yield* DateTime.now,
              }),
            );
          }),
        ),
        Effect.tapCause(
          Effect.fnUntraced(function* (cause) {
            yield* events.publish(
              PostDataTransferEvent.make({
                eventName: "post-data-transfer",
                fromEndpoint,
                toEndpoint,
                outcome: "failure",
                accelerated: false,
                failureDetail: events.redactText(failureDetail(cause)),
                durationMs: (yield* Clock.currentTimeMillis) - startedAt,
                timestamp: yield* DateTime.now,
              }),
            );
          }),
        ),
      );
    }),
    transferStream: (spec) =>
      Stream.concat(
        Stream.make({ phase: "started" as const, transferredBytes: 0 }),
        Stream.unwrap(
          makeDataMoverService(selectedProvider, events, persistence)
            .transfer(spec)
            .pipe(
              Effect.map((result) =>
                Stream.make({
                  phase: "completed" as const,
                  transferredBytes: result.sizeBytes ?? 0,
                  ...(result.digest === undefined ? {} : { digest: result.digest }),
                }),
              ),
            ),
        ),
      ),
    snapshot: Effect.fn("DataMover.snapshot")(function* (store, opts) {
      const provider = yield* selectedProvider;
      if (opts?.volumeSnapshot === "native" && provider.capabilities.volumeSnapshot !== "native") {
        return yield* Effect.fail(
          new DataEndpointUnsupportedError({
            message: `Provider ${provider.id} does not support native volume snapshots.`,
            fromEndpoint: "volume",
            toEndpoint: "nativeSnapshot",
            remediation:
              "Use a provider with native volume snapshots or select volumeSnapshot: copy for a host archive.",
          }),
        );
      }
      const snapshotId = randomUUID();
      let rollbackNative: VolumeSnapshotRef | undefined;
      let rollbackArchive: string | undefined;
      let sidecarCommitted = false;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Best-effort: a native image this misses is reclaimed by orphan GC after its grace period.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (sidecarCommitted) return;
              if (rollbackNative !== undefined)
                yield* Effect.scoped(provider.removeVolumeSnapshot(rollbackNative));
              if (rollbackArchive !== undefined) yield* removeSnapshotArchive(rollbackArchive);
            }).pipe(
              Effect.catchCause((cause) => Effect.logWarning("Snapshot rollback did not complete.", cause)),
            ),
          );
          yield* events.publish(
            PreVolumeSnapshotEvent.make({
              eventName: "pre-volume-snapshot",
              volume: store,
              ...(opts?.format === undefined ? {} : { format: opts.format }),
              timestamp: yield* DateTime.now,
            }),
          );
          const createdAt = yield* DateTime.now;
          const sources = yield* provider
            .listVolumes({ app: store.app, store: store.store })
            .pipe(Effect.mapError((cause) => providerFailure("listVolumes", cause)));
          const { source, owner: sourceOwner } = yield* snapshotSourceOwner(sources, store, snapshotId);
          const owner = {
            ...sourceOwner,
            ...(opts?.repoGroupKey === undefined ? {} : { repoGroupKey: opts.repoGroupKey }),
          };
          if (opts?.metadata !== undefined && !matchesSnapshotSource(source, opts.metadata, owner)) {
            return yield* Effect.fail(
              new SnapshotOwnershipError({
                message: "Physical snapshot source identity changed before creation.",
                snapshotId,
                sourceVolumeInstanceId: opts.metadata.volumeInstanceId,
                ...(physicalVolumeGeneration(source) === undefined
                  ? {}
                  : { targetVolumeInstanceId: physicalVolumeGeneration(source) }),
                remediation: "Re-observe the database volume and retry the snapshot operation.",
              }),
            );
          }
          const useNative =
            opts?.volumeSnapshot === "native" ||
            (opts?.volumeSnapshot !== "copy" && provider.capabilities.volumeSnapshot === "native");
          const format = opts?.format ?? "tar";
          const archivePath = yield* snapshotArchivePath(persistence.paths, {
            owner,
            store,
            id: snapshotId,
            format,
          });
          const storeIdentity = yield* snapshotStoreIdentity(persistence);
          const native: VolumeSnapshotRef | undefined = useNative
            ? yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  provider.snapshotVolume({
                    volume: store,
                    snapshotId,
                    ...(opts?.label === undefined ? {} : { label: opts.label }),
                    labels: {
                      ...opts?.labels,
                      [SNAPSHOT_STORE_LABEL]: storeIdentity,
                      [APP_ROOT_LABEL]: owner.appRoot,
                    },
                  }),
                ).pipe(
                  Effect.tap((ref) =>
                    Effect.sync(() => {
                      rollbackNative = ref;
                    }),
                  ),
                  Effect.mapError((cause) => providerFailure("snapshotVolume", cause)),
                ),
              )
            : undefined;
          if (native === undefined) rollbackArchive = archivePath;
          const copyResult =
            native === undefined
              ? yield* writeStreamToEndpoint(
                  selectedProvider,
                  {
                    from: { _tag: "volume", app: store.app, store: store.store },
                    to: {
                      _tag: "hostArchive",
                      path: absolutePath(archivePath),
                      format,
                    },
                    overwrite: true,
                  },
                  streamFromEndpoint(selectedProvider, {
                    _tag: "volume",
                    app: store.app,
                    store: store.store,
                  }),
                  persistence.paths.scratchDir,
                )
              : undefined;
          const archiveIntegrity =
            copyResult === undefined
              ? undefined
              : yield* collectVerifiedStream({
                  body: byteStreamFromHost(archivePath),
                }).pipe(
                  Effect.mapError((error) =>
                    error instanceof VerifiedStreamError
                      ? mapVerifiedError(error, {
                          from: { _tag: "volume", app: store.app, store: store.store },
                          to: {
                            _tag: "hostArchive",
                            path: absolutePath(archivePath),
                            format,
                          },
                        })
                      : error,
                  ),
                );
          const digest = native?.digest ?? archiveIntegrity?.sha256;
          const sizeBytes = native?.sizeBytes ?? archiveIntegrity?.sizeBytes;
          if (digest === undefined || sizeBytes === undefined) {
            return yield* Effect.fail(
              new DataTransferError({
                message: "Snapshot provider did not return immutable artifact integrity.",
                operation: "snapshot",
                remediation: "Retry after checking provider snapshot support with `lando doctor`.",
              }),
            );
          }
          const info: SnapshotInfo = {
            owner,
            id: snapshotId,
            store,
            digest,
            sizeBytes,
            createdAt,
            ...(native === undefined ? { format } : { native }),
            ...(opts?.label === undefined ? {} : { label: opts.label }),
            ...(opts?.labels === undefined ? {} : { labels: opts.labels }),
            ...(opts?.metadata === undefined ? {} : { metadata: opts.metadata }),
          };
          const bucket = yield* openSnapshot(persistence, snapshotHandle(info));
          // The sidecar is the commit point. The write runs uninterruptibly so its outcome is
          // observable; after a failure, the sidecar's presence decides whether data was committed
          // (keep the artifact) or not (roll it back). An unknown answer keeps the artifact.
          yield* Effect.uninterruptible(
            bucket.set(info).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  sidecarCommitted = true;
                }),
              ),
              Effect.tapError(() =>
                bucket.exists.pipe(
                  Effect.catch(() => Effect.succeed(true)),
                  Effect.tap((committed) =>
                    Effect.sync(() => {
                      sidecarCommitted = committed;
                    }),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.mapError((cause) => stateFailure("write-sidecar", cause)));
          yield* events.publish(
            PostVolumeSnapshotEvent.make({
              eventName: "post-volume-snapshot",
              volume: store,
              snapshotId,
              outcome: "success",
              timestamp: yield* DateTime.now,
            }),
          );
          return snapshotHandle(info);
        }),
      ).pipe(
        Effect.tapCause(
          Effect.fnUntraced(function* (cause) {
            yield* events.publish(
              PostVolumeSnapshotEvent.make({
                eventName: "post-volume-snapshot",
                volume: store,
                snapshotId,
                outcome: "failure",
                failureDetail: events.redactText(failureDetail(cause)),
                timestamp: yield* DateTime.now,
              }),
            );
          }),
        ),
      );
    }),
    restore: Effect.fn("DataMover.restore")(function* (handle, store, opts) {
      const provider = yield* selectedProvider;
      const info = yield* findSnapshotInfo(persistence, handle);
      if (info.native !== undefined && info.native.provider !== provider.id) {
        return yield* Effect.fail(
          new DataTransferError({
            message: `Native snapshot provider ${info.native.provider} differs from target provider ${provider.id}.`,
            operation: "restoreVolume",
            remediation:
              "Use logical db:export on the source provider, then db:import or db:seed <file> on the target provider.",
          }),
        );
      }
      const targets = yield* provider
        .listVolumes({ app: store.app, store: store.store })
        .pipe(Effect.mapError((cause) => providerFailure("listVolumes", cause)));
      const target = targets.find(
        (candidate) => candidate.ref.app === store.app && candidate.ref.store === store.store,
      );
      yield* requireSnapshotTargetOwner(info, target);
      if (info.native === undefined) {
        const archivePath = yield* snapshotArchivePath(persistence.paths, info);
        if (info.metadata !== undefined || opts?.mode === "seed") {
          if (opts?.mode === "seed") {
            yield* requireSnapshotSeedTarget(persistence.stateStore, info, { volume: target, store });
          } else if (
            info.metadata !== undefined &&
            !matchesSnapshotSource(target, info.metadata, info.owner)
          ) {
            return yield* Effect.fail(
              new SnapshotOwnershipError({
                message: "Physical snapshot ownership does not match the target volume instance.",
                snapshotId: info.id,
                sourceVolumeInstanceId: info.metadata.volumeInstanceId,
                ...(physicalVolumeGeneration(target) === undefined
                  ? {}
                  : { targetVolumeInstanceId: physicalVolumeGeneration(target) }),
                remediation:
                  "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
              }),
            );
          }
        }
        const staged = yield* stageVerifiedStream({
          body: byteStreamFromHost(archivePath),
          scratchDir: persistence.paths.scratchDir,
          prefix: "snapshot",
          expectedSha256: info.digest,
          expectedSizeBytes: info.sizeBytes,
        }).pipe(
          Effect.mapError((error) =>
            error instanceof VerifiedStreamError
              ? mapVerifiedError(error, {
                  from: {
                    _tag: "hostArchive",
                    path: absolutePath(archivePath),
                    format: info.format ?? "tar",
                  },
                  to: { _tag: "volume", app: store.app, store: store.store },
                })
              : error,
          ),
        );
        return yield* writeStreamToEndpoint(
          selectedProvider,
          {
            from: {
              _tag: "hostArchive",
              path: absolutePath(archivePath),
              format: info.format ?? "tar",
            },
            to: { _tag: "volume", app: store.app, store: store.store },
            overwrite: true,
          },
          streamFromEndpoint(selectedProvider, {
            _tag: "hostArchive",
            path: absolutePath(staged.path),
            format: info.format ?? "tar",
          }),
          persistence.paths.scratchDir,
        ).pipe(Effect.asVoid);
      }
      const targetGeneration = physicalVolumeGeneration(target);
      if (opts?.mode === "seed") {
        yield* requireSnapshotSeedTarget(persistence.stateStore, info, { volume: target, store });
      }
      if (targetGeneration === undefined) {
        return yield* Effect.fail(
          new SnapshotOwnershipError({
            message: "Physical restore target identity is unknown.",
            snapshotId: info.id,
            sourceVolumeInstanceId: info.metadata?.volumeInstanceId ?? "unknown",
            remediation: "Use a logical export and import when the target volume identity cannot be proven.",
          }),
        );
      }
      if (info.metadata !== undefined) {
        if (opts?.mode !== "seed" && !matchesSnapshotSource(target, info.metadata, info.owner)) {
          return yield* Effect.fail(
            new SnapshotOwnershipError({
              message: "Physical snapshot ownership does not match the target volume instance.",
              snapshotId: info.id,
              sourceVolumeInstanceId: info.metadata.volumeInstanceId,
              ...(physicalVolumeGeneration(target) === undefined
                ? {}
                : { targetVolumeInstanceId: physicalVolumeGeneration(target) }),
              remediation:
                "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
            }),
          );
        }
      }
      return yield* provider
        .restoreVolume({
          snapshot: info.native,
          target: store,
          expectedTargetGeneration: targetGeneration,
          overwrite: true,
        })
        .pipe(Effect.mapError((cause) => providerFailure("restoreVolume", cause)));
    }),
    listSnapshots: Effect.fn("DataMover.listSnapshots")((filter) => listSnapshotInfos(persistence, filter)),
    resolveSnapshot: Effect.fn("DataMover.resolveSnapshot")((reference, scope) =>
      resolveSnapshotInfo(persistence, reference, scope),
    ),
    findOrphanedSnapshots: Effect.flatMap(
      selectedProvider,
      (provider) =>
        orphanedSnapshotMethods({
          provider,
          storeIdentity: snapshotStoreIdentity(persistence),
          index: listSnapshotInfos(persistence, {}),
          legacyReferences: legacySnapshotReferences(persistence.paths),
        }).findOrphanedSnapshots,
    ),
    removeOrphanedSnapshot: (artifact) =>
      Effect.flatMap(selectedProvider, (provider) =>
        orphanedSnapshotMethods({
          provider,
          storeIdentity: snapshotStoreIdentity(persistence),
          index: listSnapshotInfos(persistence, {}),
          legacyReferences: legacySnapshotReferences(persistence.paths),
        }).removeOrphanedSnapshot(artifact),
      ),
    removeSnapshot: (handle) => removeCatalogSnapshot(persistence, selectedProvider, handle),
    pruneSnapshots: Effect.fn("DataMover.pruneSnapshots")((policy: PrunePolicy) =>
      listSnapshotInfos(persistence, policy.filter ?? {}).pipe(
        Effect.map((infos) => {
          if (policy.keepLatest === undefined) {
            return [];
          }
          const retained = new Set(policy.retainSnapshotIds?.map(String));
          return [...infos]
            .filter((info) => {
              const manual =
                info.metadata?.recoveryReason === undefined || info.metadata.recoveryReason === "manual";
              return policy.recovery === true ? !manual : manual;
            })
            .sort(
              (left, right) =>
                Number(retained.has(String(right.id))) - Number(retained.has(String(left.id))) ||
                DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
            )
            .slice(policy.keepLatest);
        }),
        Effect.flatMap((remove) =>
          Effect.forEach(remove, (info) =>
            removeCatalogSnapshot(persistence, selectedProvider, snapshotHandle(info)).pipe(
              Effect.as(info.id),
            ),
          ),
        ),
      ),
    ),
  });

export const layer: Layer.Layer<
  DataMover,
  never,
  RuntimeProviderRegistry | PathsService | StateStore | EventService | RedactionService
> = Layer.suspend(() =>
  Layer.effect(
    DataMover,
    Effect.gen(function* () {
      const paths = yield* PathsService;
      const stateStore = yield* StateStore;
      const providerRegistry = yield* RuntimeProviderRegistry;
      const eventService = yield* Effect.serviceOption(EventService);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = yield* makeEvents(eventService, redaction);
      const persistence = { paths, stateStore, providerRegistry };
      const service = (app?: import("@lando/sdk/schema").AppId, providerId?: ProviderId) => {
        const selected = Effect.gen(function* () {
          // Explicit call-time bindings come from operations that already selected
          // their provider. The bootstrap placeholder is never a selection.
          const supplied = yield* Effect.serviceOption(RuntimeProvider);
          if (Option.isSome(supplied) && supplied.value.id !== "stub") return supplied.value;
          if (app === undefined) return yield* providerRegistry.select(providerId);
          let uninspected: ProviderUnavailableError | undefined;
          for (const id of yield* providerRegistry.list) {
            const inspected = yield* Effect.result(
              providerRegistry
                .select(id)
                .pipe(Effect.flatMap((candidate) => candidate.appliedPlans ?? Effect.succeed([]))),
            );
            if (inspected._tag === "Failure") {
              uninspected ??= new ProviderUnavailableError({
                providerId: id,
                operation: "select",
                message: `Could not inspect applied plans on provider ${id} for app ${app}: ${inspected.failure.message}`,
                remediation: `Inspect provider ${id} with lando doctor --provider=${id} and repair it before transferring app ${app}'s data.`,
                cause: inspected.failure,
              });
              continue;
            }
            const plan = inspected.success.find((plan) => plan.id === app);
            if (plan !== undefined) return yield* providerRegistry.select(plan);
          }
          if (uninspected !== undefined) return yield* Effect.fail(uninspected);
          return yield* Effect.fail(
            new ProviderUnavailableError({
              providerId: "unknown",
              operation: "select",
              message: `No applied provider plan was found for app ${app}.`,
              remediation: `Run lando start in app ${app}'s root before transferring its runtime data.`,
            }),
          );
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DataTransferError({
                message: cause.message,
                operation: "select",
                cause,
                remediation:
                  "remediation" in cause && typeof cause.remediation === "string"
                    ? cause.remediation
                    : "Run lando setup to install a provider, then lando doctor --all to inspect its availability.",
              }),
          ),
        );
        return makeDataMoverService(selected, events, persistence);
      };
      return DataMover.of({
        transfer: (spec) => service(appFromEndpoint(spec.from) ?? appFromEndpoint(spec.to)).transfer(spec),
        volumeInitialization: Effect.fn("DataMover.volumeInitialization")((identity) =>
          sharedVolumeInitialization(stateStore, identity),
        ),
        transferStream: (spec) =>
          service(appFromEndpoint(spec.from) ?? appFromEndpoint(spec.to)).transferStream(spec),
        snapshot: (store, opts) => service(store.app).snapshot(store, opts),
        restore: (handle, store, opts) => service(store.app).restore(handle, store, opts),
        listSnapshots: (filter) => service().listSnapshots(filter),
        resolveSnapshot: (reference, scope) => service().resolveSnapshot(reference, scope),
        findOrphanedSnapshots: Effect.suspend(() => service().findOrphanedSnapshots),
        removeOrphanedSnapshot: (artifact) =>
          service(undefined, ProviderId.make(artifact.ref.provider)).removeOrphanedSnapshot(artifact),
        removeSnapshot: (handle) => service().removeSnapshot(handle),
        pruneSnapshots: (policy) => service().pruneSnapshots(policy),
      });
    }),
  ),
);
