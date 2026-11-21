import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { APP_ROOT_LABEL, SNAPSHOT_STORE_LABEL } from "@lando/container-runtime/labels";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { isPathWithin } from "@lando/paths";
import { isProviderError } from "@lando/redaction/provider-error";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { mapFailures, mapStreamFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
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
  StateStoreError,
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
  type AppId,
  type DataEndpoint,
  type DataTransferProgress,
  type DataTransferResult,
  type DataTransferSpec,
  ProviderId,
  type PrunePolicy,
  type SnapshotInfo,
  type VolumeInfo,
  type VolumeRef,
  type VolumeSnapshotRef,
  planDataId,
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
import { VerifiedStreamError, persistVerifiedStream } from "@lando/sdk/verified-stream";
import { findRealpathAncestor, resolveStatePath } from "@lando/state-store/paths";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { withPhysicalVolumeLock, withPhysicalVolumeLocks } from "@lando/state-store/volume-lock";
import {
  Cause,
  Clock,
  type Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import {
  decodeArchiveStream,
  decodeCompressionStream,
  encodeArchiveStream,
  encodeCompressionStream,
} from "./archive-stream.ts";
import { legacySnapshotReferences, orphanedSnapshotMethods } from "./orphaned-snapshots.ts";
import { providerFailure } from "./provider-failure.ts";
import { checkedServiceCommand, serviceCommandStdout } from "./service-command-redaction.ts";
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
import { endpointName, hostReadError, mapVerifiedError } from "./transfer-errors.ts";
import { sharedVolumeInitialization } from "./volume-initialization.ts";
import { withVolumeTransaction, withVolumeTransactions } from "./volume-transaction.ts";

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

const absolutePath = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const providerId = (id: string) => Schema.decodeUnknownSync(ProviderId)(id);

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

  const options = { sourceEnv: { ...process.env } };
  const redactor = Option.isSome(redaction)
    ? redaction.value.forProfile("secrets", options)
    : Effect.succeed(createStandaloneRedactor("secrets", options));
  return redactor.pipe(Effect.map((redactor) => ({ redactText: redactor.redactString, publish })));
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
    while (true) {
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
                remediation: `Recreate "${path}" as a valid tar archive before importing it.`,
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
                remediation: `Recreate "${path}" as a valid ${format} archive before importing it.`,
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
  command: typeof command === "string" ? ["sh", "-c", command] : command,
  ...(env === undefined ? {} : { env }),
});

const realpathNearestExisting = async (path: string): Promise<string> => {
  const found = await findRealpathAncestor(path, (candidate) =>
    realpath(candidate).catch((cause: unknown) => {
      if (errnoCode(cause) === "ENOENT") return null;
      throw cause;
    }),
  );
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
    mapFailures((cause) => stateFailure("canonicalize", cause)),
  );

const resolveAppRoot = Effect.fnUntraced(function* (paths: ReadonlyArray<string>) {
  const cwdRoot = yield* findAppRoot();
  if (cwdRoot !== undefined) return cwdRoot;

  for (const path of paths) {
    const endpointRoot = yield* findAppRoot(path);
    if (endpointRoot !== undefined) return endpointRoot;
  }

  return yield* discoveryCwd();
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
    catch: (cause) => hostReadError(path, cause, "stat-host"),
  }).pipe(Effect.map((info) => info.isDirectory()));

const byteStreamFromHost = (path: string): Stream.Stream<Uint8Array, DataTransferError> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.try({
        try: () => Bun.file(path).stream().getReader(),
        catch: (cause) => hostReadError(path, cause),
      }),
      // Cancel, not just release the lock, so a consumer that stops early closes the file now.
      (reader) => Effect.promise(() => reader.cancel().catch(() => undefined)),
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

/** SHA-256 and byte count of the exact payload bytes that flow through a stream. */
const archiveTap = () => {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let sealed: { readonly sha256: string; readonly sizeBytes: number } | undefined;
  return {
    stream: <E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
      body.pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            hash.update(chunk);
            sizeBytes += chunk.byteLength;
          }),
        ),
      ),
    result: () => {
      sealed ??= { sha256: hash.digest("hex"), sizeBytes };
      return sealed;
    },
  };
};

type VolumeEndpointRef = { readonly app: AppId; readonly store: string };

const coordinationKeyFor = (
  provider: Context.Service.Shape<typeof RuntimeProvider>,
  ref: VolumeEndpointRef,
): Effect.Effect<string, DataTransferError> =>
  provider.locateVolume(ref).pipe(
    mapFailures((cause) => providerFailure("locateVolume", cause)),
    Effect.map((locator) => locator.coordinationKey),
  );

const volumeLockFailure = <E>(cause: E | StateStoreError) =>
  cause instanceof StateStoreError ? stateFailure("volume-lock", cause) : cause;

const mapLockFailure = <A, E, R>(effect: Effect.Effect<A, E | StateStoreError, R>) =>
  effect.pipe(mapFailures(volumeLockFailure<E>));

/**
 * Physical-volume lock first, then the transaction gate; every volume path uses this order.
 * A caller that already holds the lock (SQL recovery) re-enters it and then waits only on the
 * gate, while a non-holder waits on the lock without holding a gate, so no wait cycle exists.
 */
const withVolumeTransactionLock = <A, E, R>(
  stateStore: Context.Service.Shape<typeof StateStore>,
  coordinationKey: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateStoreError, R> =>
  withPhysicalVolumeLock(stateStore, coordinationKey, withVolumeTransaction(coordinationKey, body));

const withVolumeTransactionLocks = <A, E, R>(
  stateStore: Context.Service.Shape<typeof StateStore>,
  coordinationKeys: ReadonlyArray<string>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateStoreError, R> =>
  withPhysicalVolumeLocks(stateStore, coordinationKeys, withVolumeTransactions(coordinationKeys, body));

/**
 * Hold every involved volume's physical lock, acquired in sorted order, for the whole
 * operation. Nested DataMover work re-enters instead of deadlocking.
 */
const withEndpointVolumeLocks = Effect.fnUntraced(function* <A, E, R>(input: {
  readonly provider: Context.Service.Shape<typeof RuntimeProvider>;
  readonly endpoints: ReadonlyArray<DataEndpoint>;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
  readonly body: Effect.Effect<A, E, R>;
}): Effect.fn.Return<A, E | DataTransferError | StateStoreError, R> {
  const refs = input.endpoints.flatMap((endpoint) =>
    endpoint._tag === "volume" ? [{ app: endpoint.app, store: endpoint.store }] : [],
  );
  const keys = yield* Effect.forEach(refs, (ref) => coordinationKeyFor(input.provider, ref));
  return yield* withVolumeTransactionLocks(input.stateStore, keys, input.body);
});

/** Hold a volume's physical lock while a caller-owned stream is consumed. */
const streamUnderVolumeLock = <A, E, R>(input: {
  readonly provider: Context.Service.Shape<typeof RuntimeProvider>;
  readonly ref: VolumeEndpointRef;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
  readonly stream: Stream.Stream<A, E | DataTransferError, R>;
}): Stream.Stream<A, E | DataTransferError, R | Scope.Scope> =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const coordinationKey = yield* coordinationKeyFor(input.provider, input.ref);
        const queue = yield* Queue.bounded<A, E | DataTransferError | StateStoreError | Cause.Done>(16);
        // The exit covers lock acquisition as well as the stream, so a lock failure ends the
        // consumer's queue instead of leaving it waiting forever.
        yield* withVolumeTransactionLock(
          input.stateStore,
          coordinationKey,
          Stream.runForEach(input.stream, (item) => Queue.offer(queue, item)),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Queue.failCause(queue, exit.cause) : Queue.end(queue).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        );
        return Stream.fromQueue(queue).pipe(mapStreamFailures(volumeLockFailure<E | DataTransferError>));
      }),
    ),
  );

type DataProvider = Effect.Effect<Context.Service.Shape<typeof RuntimeProvider>, DataTransferError>;

/**
 * Fail when a generic volume import would replace an existing volume without overwrite.
 * Checked once before extraction: the extractor creates the target itself, so a later
 * listing cannot tell a conflict from the import's own volume.
 */
const requireVolumeImportAdmission = Effect.fnUntraced(function* (
  provider: Context.Service.Shape<typeof RuntimeProvider>,
  target: { readonly app: AppId; readonly store: string },
  overwrite: boolean | undefined,
) {
  if (overwrite === true) return;
  const volumes = yield* provider
    .listVolumes({ app: target.app, store: target.store })
    .pipe(mapFailures((cause) => providerFailure("listVolumes", cause)));
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
});

interface CopyRestoreTargetCheck {
  readonly persistence: SnapshotPersistence & { readonly privateFileAccess: PrivateFileAccess };
  readonly info: SnapshotInfo;
  readonly target: VolumeInfo | undefined;
  readonly store: VolumeRef;
  readonly mode: "restore" | "seed" | undefined;
}

/** Ownership and physical-generation gate shared by the pre-stage and pre-mutation checks. */
const requireCopyRestoreTarget = Effect.fnUntraced(function* (input: CopyRestoreTargetCheck) {
  const targetGeneration = input.target === undefined ? undefined : physicalVolumeGeneration(input.target);
  if (input.target === undefined || targetGeneration === undefined) {
    return yield* Effect.fail(
      new SnapshotOwnershipError({
        message: "Physical restore target identity is unknown.",
        snapshotId: input.info.id,
        sourceVolumeInstanceId: input.info.metadata?.volumeInstanceId ?? "unknown",
        remediation: "Use a logical export and import when the target volume identity cannot be proven.",
      }),
    );
  }
  yield* requireSnapshotTargetOwner(input.info, input.target);
  if (input.mode === "seed") {
    yield* requireSnapshotSeedTarget(input.persistence.stateStore, input.info, {
      volume: input.target,
      store: input.store,
    });
    return;
  }
  if (
    input.info.metadata !== undefined &&
    !matchesSnapshotSource(input.target, input.info.metadata, input.info.owner)
  ) {
    return yield* Effect.fail(
      new SnapshotOwnershipError({
        message: "Physical snapshot ownership does not match the target volume instance.",
        snapshotId: input.info.id,
        sourceVolumeInstanceId: input.info.metadata.volumeInstanceId ?? "unknown",
        targetVolumeInstanceId: targetGeneration,
        remediation:
          "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
      }),
    );
  }
  // The recorded physical source generation is independent of database metadata; a
  // restore without it cannot prove the target is the volume the snapshot came from.
  const recordedGeneration = input.info.sourceVolumeGeneration ?? input.info.metadata?.volumeInstanceId;
  if (recordedGeneration === undefined) {
    return yield* Effect.fail(
      new SnapshotOwnershipError({
        message: "The snapshot does not record its physical source volume generation.",
        snapshotId: input.info.id,
        sourceVolumeInstanceId: "unknown",
        remediation:
          "Seed a fresh volume or use a logical export and import; this snapshot cannot be restored physically.",
      }),
    );
  }
  if (targetGeneration !== recordedGeneration) {
    return yield* Effect.fail(
      new SnapshotOwnershipError({
        message: "Physical restore target generation does not match the snapshot's source generation.",
        snapshotId: input.info.id,
        sourceVolumeInstanceId: recordedGeneration,
        targetVolumeInstanceId: targetGeneration,
        remediation:
          "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
      }),
    );
  }
});

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
        .pipe(mapStreamFailures((cause) => providerFailure("copyFromService", cause)));
    case "volume":
      if (provider.capabilities.volumeArchive !== true) {
        return Stream.fail(
          new DataEndpointUnsupportedError({
            message: "Volume export requires typed volume archive support.",
            fromEndpoint: endpointName(endpoint),
            toEndpoint: "stream",
            remediation: "Use a provider that streams whole-volume archives.",
          }),
        );
      }
      return provider
        .exportVolume({ app: endpoint.app, store: endpoint.store })
        .pipe(mapStreamFailures((cause) => providerFailure("exportVolume", cause)));
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
        .pipe(mapStreamFailures((cause) => providerFailure("exportArtifact", cause)));
    case "serviceCmd": {
      const command = providerCommandSpec(endpoint.command, endpoint.env);
      return serviceCommandStdout(
        provider.execStream({ app: endpoint.app, service: endpoint.service }, command),
        endpoint,
      );
    }
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
  staging: { readonly transferStagingDir: string; readonly privateFileAccess: PrivateFileAccess },
): Effect.fn.Return<DataTransferResult, DataMoverTransferError, Scope.Scope> {
  const target = spec.to;
  switch (target._tag) {
    case "hostPath": {
      const result = yield* persistVerifiedStream({
        body,
        destinationPath: target.path,
        expectedSha256: spec.expectedDigest,
      }).pipe(
        mapFailures((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      return { accelerated: false, sizeBytes: result.sizeBytes, digest: result.sha256 };
    }
    case "hostArchive": {
      const staged = yield* stageVerifiedStream({
        body,
        ...staging,
        prefix: "archive",
        ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
      }).pipe(
        mapFailures((error) =>
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
        mapFailures((error) =>
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
          ...staging,
          prefix: "service",
          ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
        }).pipe(
          mapFailures((error) =>
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
          .pipe(mapFailures((cause) => providerFailure("copyToService", cause)));
        return {
          accelerated: true,
          sizeBytes: staged.verified.sizeBytes,
          digest: staged.verified.sha256,
        };
      }
    }
    case "volume": {
      const provider = yield* selectedProvider;
      if (provider.capabilities.volumeArchive !== true)
        return yield* failUnsupported(spec.from, target, "typed volume archives are unavailable");
      {
        yield* requireVolumeImportAdmission(provider, target, spec.overwrite);
        const tap = archiveTap();
        yield* provider
          .importVolume<
            | ArchiveFormatError
            | DataTransferError
            | DataEndpointUnsupportedError
            | DataChecksumMismatchError
            | DataTargetExistsError,
            Scope.Scope
          >({
            target: { app: target.app, store: target.store },
            archive: tap.stream(body),
            beforeCommit: Effect.gen(function* () {
              const captured = tap.result();
              if (spec.expectedDigest !== undefined && captured.sha256 !== spec.expectedDigest) {
                return yield* Effect.fail(
                  new DataChecksumMismatchError({
                    message: "Volume archive checksum did not match the expected SHA-256.",
                    expectedSha256: spec.expectedDigest,
                    actualSha256: captured.sha256,
                    remediation: "Retry the transfer from a trusted source; verification cannot be skipped.",
                  }),
                );
              }
            }),
          })
          .pipe(
            mapFailures((cause) => (isProviderError(cause) ? providerFailure("importVolume", cause) : cause)),
          );
        const captured = tap.result();
        return {
          accelerated: false,
          sizeBytes: captured.sizeBytes,
          digest: captured.sha256,
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
          ...staging,
          prefix: "artifact",
          ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
        }).pipe(
          mapFailures((error) =>
            error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
          ),
        );
        yield* provider
          .importArtifact(
            byteStreamFromHost(staged.path).pipe(
              mapStreamFailures(
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
          .pipe(mapFailures((cause) => providerFailure("importArtifact", cause)));
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
        ...staging,
        prefix: "command",
        ...(spec.expectedDigest === undefined ? {} : { expectedSha256: spec.expectedDigest }),
      }).pipe(
        mapFailures((error) =>
          error instanceof VerifiedStreamError ? mapVerifiedError(error, spec) : error,
        ),
      );
      const stdinStream = yield* Stream.toAsyncIterableEffect(byteStreamFromHost(staged.path));
      const command = { ...providerCommandSpec(target.command, target.env), stdinStream };
      yield* checkedServiceCommand(
        provider.execStream({ app: target.app, service: target.service }, command),
        target,
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
  persistence: SnapshotPersistence & { readonly privateFileAccess: PrivateFileAccess },
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
        if (
          (spec.from._tag === "volume" && spec.to._tag === "artifact") ||
          (spec.from._tag === "artifact" && spec.to._tag === "volume")
        ) {
          return yield* failUnsupported(
            spec.from,
            spec.to,
            "artifact endpoints carry engine image archives, not volume tree archives",
          );
        }
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
        const result = yield* writeStreamToEndpoint(selectedProvider, spec, body, {
          transferStagingDir: persistence.paths.transferStagingDir,
          privateFileAccess: persistence.privateFileAccess,
        });
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

      const lockedRun = [spec.from, spec.to].some((endpoint) => endpoint._tag === "volume")
        ? Effect.flatMap(selectedProvider, (provider) =>
            mapLockFailure(
              withEndpointVolumeLocks({
                provider,
                endpoints: [spec.from, spec.to],
                stateStore: persistence.stateStore,
                body: run,
              }),
            ),
          )
        : run;
      return yield* events.publish(pre).pipe(
        Effect.andThen(lockedRun),
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
    // Source bytes for a caller-owned sink: success is source EOF + clean producer exit, not sink receipt.
    read: (from) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const fromEndpoint = events.redactText(endpointName(from));
          const toEndpoint = events.redactText("stream");
          const app = appFromEndpoint(from);
          const service = serviceFromEndpoint(from);
          const publishFailure = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
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
          });
          yield* events.publish(
            PreDataTransferEvent.make({
              eventName: "pre-data-transfer",
              fromEndpoint,
              toEndpoint,
              ...(app === undefined ? {} : { app }),
              ...(service === undefined ? {} : { service }),
              timestamp: yield* DateTime.now,
            }),
          );
          yield* validateHostEndpoints({ from, to: { _tag: "stream" } }, persistence.paths.scratchDir).pipe(
            Effect.tapCause(publishFailure),
          );
          let sizeBytes = 0;
          let reachedEnd = false;
          // The source gets its own scope, and the outcome is published from the outermost exit, so
          // producer cleanup has finished first. An early stop (EOF never reached) counts as a failure.
          const source =
            from._tag === "volume"
              ? Stream.unwrap(
                  Effect.map(selectedProvider, (provider) =>
                    streamUnderVolumeLock({
                      provider,
                      ref: { app: from.app, store: from.store },
                      stateStore: persistence.stateStore,
                      stream: streamFromProvider(provider, from),
                    }),
                  ),
                )
              : streamFromEndpoint(selectedProvider, from);
          return Stream.scoped(
            source.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  sizeBytes += chunk.byteLength;
                }),
              ),
              Stream.onEnd(
                Effect.sync(() => {
                  reachedEnd = true;
                }),
              ),
            ),
          ).pipe(
            Stream.onExit((exit) =>
              Exit.isSuccess(exit) && reachedEnd
                ? Effect.gen(function* () {
                    yield* events.publish(
                      PostDataTransferEvent.make({
                        eventName: "post-data-transfer",
                        fromEndpoint,
                        toEndpoint,
                        outcome: "success",
                        accelerated: false,
                        sizeBytes,
                        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
                        timestamp: yield* DateTime.now,
                      }),
                    );
                  })
                : publishFailure(Exit.isFailure(exit) ? exit.cause : Cause.interrupt()),
            ),
          );
        }),
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
      const coordinationKey = yield* coordinationKeyFor(provider, store);
      const snapshotId = randomUUID();
      let rollbackNative: VolumeSnapshotRef | undefined;
      let rollbackArchive: string | undefined;
      let sidecarCommitted = false;
      const capture = Effect.scoped(
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
            .pipe(mapFailures((cause) => providerFailure("listVolumes", cause)));
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
                sourceVolumeInstanceId: opts.metadata.volumeInstanceId ?? "unknown",
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
          const sourceGeneration = physicalVolumeGeneration(source);
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
                  mapFailures((cause) => providerFailure("snapshotVolume", cause)),
                ),
              )
            : undefined;
          if (native === undefined) rollbackArchive = archivePath;
          const sourceEndpoint = { _tag: "volume" as const, app: store.app, store: store.store };
          const tree = streamFromEndpoint(selectedProvider, sourceEndpoint);
          const storedArchive =
            native === undefined
              ? yield* persistVerifiedStream({
                  body: format === "tar" ? tree : encodeCompressionStream(tree, format, archivePath),
                  destinationPath: archivePath,
                }).pipe(
                  mapFailures((error) =>
                    error instanceof VerifiedStreamError
                      ? mapVerifiedError(error, {
                          from: sourceEndpoint,
                          to: {
                            _tag: "hostArchive",
                            path: absolutePath(archivePath),
                            format,
                          },
                        })
                      : error,
                  ),
                )
              : undefined;
          const digest = native?.digest ?? storedArchive?.sha256;
          const sizeBytes = native?.sizeBytes ?? storedArchive?.sizeBytes;
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
            ...(sourceGeneration === undefined ? {} : { sourceVolumeGeneration: sourceGeneration }),
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
          ).pipe(mapFailures((cause) => stateFailure("write-sidecar", cause)));
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
      return yield* mapLockFailure(
        withVolumeTransactionLock(persistence.stateStore, coordinationKey, capture),
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
      if (
        info.sourceVolumeGeneration !== undefined &&
        info.metadata?.volumeInstanceId !== undefined &&
        info.sourceVolumeGeneration !== info.metadata.volumeInstanceId
      ) {
        return yield* Effect.fail(
          new SnapshotOwnershipError({
            message: "The snapshot records conflicting physical source volume generations.",
            snapshotId: info.id,
            sourceVolumeInstanceId: info.sourceVolumeGeneration,
            targetVolumeInstanceId: info.metadata.volumeInstanceId,
            remediation:
              "Use a logical export and import; this snapshot cannot prove which physical volume it came from.",
          }),
        );
      }
      const recordedGeneration = info.sourceVolumeGeneration ?? info.metadata?.volumeInstanceId;
      const observeTarget = () =>
        provider.listVolumes({ app: store.app, store: store.store }).pipe(
          mapFailures((cause) => providerFailure("listVolumes", cause)),
          Effect.map((volumes) =>
            volumes.find(
              (candidate) => candidate.ref.app === store.app && candidate.ref.store === store.store,
            ),
          ),
        );
      const target = yield* observeTarget();
      yield* requireSnapshotTargetOwner(info, target);
      const coordinationKey = yield* coordinationKeyFor(provider, store);

      if (info.native === undefined) {
        const archiveFormat = info.format ?? "tar";
        const archivePath = yield* snapshotArchivePath(persistence.paths, info);
        if (provider.capabilities.volumeArchive !== true) {
          return yield* failUnsupported(
            { _tag: "hostArchive", path: absolutePath(archivePath), format: archiveFormat },
            { _tag: "volume", app: store.app, store: store.store },
            "typed volume archives are unavailable",
          );
        }
        yield* requireCopyRestoreTarget({
          persistence,
          info,
          target,
          store,
          mode: opts?.mode,
        });
        yield* mapLockFailure(
          withVolumeTransactionLock(
            persistence.stateStore,
            coordinationKey,
            Effect.gen(function* () {
              const tap = archiveTap();
              const archived = tap.stream(byteStreamFromHost(archivePath));
              yield* provider
                .importVolume<
                  DataTransferError | ArchiveFormatError | DataChecksumMismatchError | SnapshotOwnershipError,
                  Scope.Scope
                >({
                  target: store,
                  archive:
                    archiveFormat === "tar"
                      ? archived
                      : decodeCompressionStream(archived, archiveFormat, archivePath),
                  beforeCommit: Effect.gen(function* () {
                    const captured = tap.result();
                    if (captured.sha256 !== info.digest || captured.sizeBytes !== info.sizeBytes) {
                      return yield* Effect.fail(
                        new DataChecksumMismatchError({
                          message: "The snapshot archive no longer matches its recorded digest and size.",
                          expectedSha256: info.digest,
                          actualSha256: captured.sha256,
                          archivePath,
                          snapshotId: info.id,
                          remediation:
                            "Remove the damaged snapshot archive and take a new snapshot; verification cannot be skipped.",
                        }),
                      );
                    }
                    // Re-observe immediately before publication so a volume replaced
                    // while the archive was read is refused.
                    yield* requireCopyRestoreTarget({
                      persistence,
                      info,
                      target: yield* observeTarget(),
                      store,
                      mode: opts?.mode,
                    });
                  }),
                })
                .pipe(
                  mapFailures((cause) =>
                    isProviderError(cause) ? providerFailure("importVolume", cause) : cause,
                  ),
                );
            }),
          ),
        );
        return;
      }

      const nativeSnapshot = info.native;
      const targetGeneration = physicalVolumeGeneration(target);
      if (targetGeneration === undefined) {
        return yield* Effect.fail(
          new SnapshotOwnershipError({
            message: "Physical restore target identity is unknown.",
            snapshotId: info.id,
            sourceVolumeInstanceId: recordedGeneration ?? "unknown",
            remediation: "Use a logical export and import when the target volume identity cannot be proven.",
          }),
        );
      }
      if (opts?.mode !== "seed") {
        if (info.metadata !== undefined && !matchesSnapshotSource(target, info.metadata, info.owner)) {
          return yield* Effect.fail(
            new SnapshotOwnershipError({
              message: "Physical snapshot ownership does not match the target volume instance.",
              snapshotId: info.id,
              sourceVolumeInstanceId: info.metadata.volumeInstanceId ?? "unknown",
              targetVolumeInstanceId: targetGeneration,
              remediation:
                "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
            }),
          );
        }
        if (recordedGeneration === undefined) {
          return yield* Effect.fail(
            new SnapshotOwnershipError({
              message: "The snapshot does not record its physical source volume generation.",
              snapshotId: info.id,
              sourceVolumeInstanceId: "unknown",
              targetVolumeInstanceId: targetGeneration,
              remediation:
                "Seed a fresh volume or use a logical export and import; this snapshot cannot be restored physically.",
            }),
          );
        }
        if (recordedGeneration !== targetGeneration) {
          return yield* Effect.fail(
            new SnapshotOwnershipError({
              message: "Physical restore target generation does not match the snapshot's source generation.",
              snapshotId: info.id,
              sourceVolumeInstanceId: recordedGeneration,
              targetVolumeInstanceId: targetGeneration,
              remediation:
                "Restore only to the original physical volume instance, or use a logical export and import for cross-volume movement.",
            }),
          );
        }
      }
      const seedAdmission = requireSnapshotSeedTarget(persistence.stateStore, info, {
        volume: target,
        store,
      });
      // Re-observe immediately before publication so a volume replaced while the snapshot
      // was staged is refused here, not only by the provider's generation check.
      const targetStillCurrent = Effect.gen(function* () {
        const current = yield* observeTarget();
        yield* requireSnapshotTargetOwner(info, current);
        const currentGeneration = physicalVolumeGeneration(current);
        if (currentGeneration !== targetGeneration) {
          return yield* Effect.fail(
            new SnapshotOwnershipError({
              message: "The restore target volume was replaced while the snapshot was staged.",
              snapshotId: info.id,
              sourceVolumeInstanceId: targetGeneration,
              ...(currentGeneration === undefined ? {} : { targetVolumeInstanceId: currentGeneration }),
              remediation: "Retry the restore against the current volume.",
            }),
          );
        }
      });
      yield* mapLockFailure(
        withVolumeTransactionLock(
          persistence.stateStore,
          coordinationKey,
          Effect.gen(function* () {
            if (opts?.mode === "seed") yield* seedAdmission;
            yield* provider
              .restoreVolume(
                {
                  snapshot: nativeSnapshot,
                  target: store,
                  expectedTargetGeneration: targetGeneration,
                  overwrite: true,
                },
                { beforeCommit: opts?.mode === "seed" ? seedAdmission : targetStillCurrent },
              )
              .pipe(
                mapFailures((cause) =>
                  isProviderError(cause) ? providerFailure("restoreVolume", cause) : cause,
                ),
              );
          }),
        ),
      );
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

export const layerWithPrivateFileAccess: Layer.Layer<
  DataMover,
  never,
  | RuntimeProviderRegistry
  | PathsService
  | StateStore
  | EventService
  | RedactionService
  | PrivateFileAccessService
> = Layer.suspend(() =>
  Layer.effect(
    DataMover,
    Effect.gen(function* () {
      const paths = yield* PathsService;
      const stateStore = yield* StateStore;
      const privateFileAccess = yield* PrivateFileAccessService;
      const providerRegistry = yield* RuntimeProviderRegistry;
      const eventService = yield* Effect.serviceOption(EventService);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = yield* makeEvents(eventService, redaction);
      const persistence = { paths, stateStore, providerRegistry, privateFileAccess };
      const service = (target?: DataEndpoint | VolumeRef, providerId?: ProviderId) => {
        const app =
          target === undefined ? undefined : "_tag" in target ? appFromEndpoint(target) : target.app;
        const volume = target !== undefined && (!("_tag" in target) || target._tag === "volume");
        const selected = Effect.gen(function* () {
          // Explicit call-time bindings come from operations that already selected
          // their provider. The bootstrap placeholder is never a selection.
          const supplied = yield* Effect.serviceOption(RuntimeProvider);
          if (Option.isSome(supplied) && supplied.value.id !== "stub") return supplied.value;
          if (app === undefined) return yield* providerRegistry.select(providerId);
          const inspectAppliedPlans = (id: ProviderId) =>
            providerRegistry
              .select(id)
              .pipe(Effect.flatMap((candidate) => candidate.appliedPlans ?? Effect.succeed([])));
          // The first provider that could not be inspected keeps its own tag and remediation.
          let uninspected: Effect.Error<ReturnType<typeof inspectAppliedPlans>> | undefined;
          for (const id of yield* providerRegistry.list) {
            const inspected = yield* Effect.result(inspectAppliedPlans(id));
            if (inspected._tag === "Failure") {
              uninspected ??= inspected.failure;
              continue;
            }
            const plan = inspected.success.find((plan) => (volume ? planDataId(plan) : plan.id) === app);
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
          mapFailures(
            (cause) =>
              new DataTransferError({
                message: cause.message,
                operation: "select",
                cause,
                remediation: cause.remediation,
              }),
          ),
        );
        return makeDataMoverService(selected, events, persistence);
      };
      return DataMover.of({
        transfer: (spec) =>
          service(appFromEndpoint(spec.from) === undefined ? spec.to : spec.from).transfer(spec),
        volumeInitialization: Effect.fn("DataMover.volumeInitialization")((identity) =>
          sharedVolumeInitialization(stateStore, identity),
        ),
        transferStream: (spec) =>
          service(appFromEndpoint(spec.from) === undefined ? spec.to : spec.from).transferStream(spec),
        read: (from) => service(from).read(from),
        snapshot: (store, opts) => service(store).snapshot(store, opts),
        restore: (handle, store, opts) => service(store).restore(handle, store, opts),
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

export const layer = layerWithPrivateFileAccess.pipe(Layer.provide(PrivateFileAccessService.layer));
