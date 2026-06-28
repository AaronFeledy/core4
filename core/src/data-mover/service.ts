import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Cause, type Context, DateTime, Effect, Layer, Option, Schema, type Scope, Stream } from "effect";

import {
  ArchiveFormatError,
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  DataTransferError,
  ProviderUnavailableError,
  SnapshotAmbiguousError,
  SnapshotNotFoundError,
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
  type SnapshotFilter,
  type SnapshotId,
  type SnapshotInfo,
  SnapshotInfo as SnapshotInfoSchema,
  type VolumeRef,
  type VolumeSnapshotRef,
} from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  type ExecChunk,
  PathsService,
  RuntimeProvider,
  StateStore,
} from "@lando/sdk/services";
import {
  type VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";
import type { LandoPaths } from "../config/paths.ts";
import { findAppRoot } from "../landofile/discovery.ts";
import { RedactionService } from "../redaction/service.ts";

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

type SnapshotIndex = ReadonlyArray<SnapshotInfo>;

interface SnapshotPersistence {
  readonly paths: LandoPaths;
  readonly stateStore: Context.Tag.Service<typeof StateStore>;
}

const noopEvents: DataMoverEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

const helperTarget = Schema.decodeUnknownSync(PortablePath)("/data");
const helperPayload = Schema.decodeUnknownSync(PortablePath)("/data/payload");
const timestamp = () => DateTime.unsafeMake(Date.now());
const snapshotIndexSchema = Schema.Array(SnapshotInfoSchema);

const absolutePath = (path: string) => Schema.decodeUnknownSync(AbsolutePath)(path);
const providerId = (id: string) => Schema.decodeUnknownSync(ProviderId)(id);

const stateFailure = (operation: string, cause: unknown): DataTransferError =>
  new DataTransferError({
    message: `Snapshot store ${operation} failed.`,
    operation,
    cause,
    remediation: "Inspect the Lando snapshot store under the configured userDataRoot.",
  });

const snapshotMissing = (snapshotId: SnapshotId, store?: VolumeRef): SnapshotNotFoundError =>
  new SnapshotNotFoundError({
    message: `Snapshot ${snapshotId} was not found.`,
    snapshotId,
    ...(store === undefined ? {} : { store: store.store }),
    remediation: "Run the snapshot list operation and retry with an existing snapshot id.",
  });

const snapshotAppDir = (persistence: SnapshotPersistence, app: string): string =>
  persistence.paths.appSnapshotsDir(app);

const snapshotStoreDir = (persistence: SnapshotPersistence, store: VolumeRef): string =>
  join(snapshotAppDir(persistence, String(store.app)), store.store);

const snapshotArchivePath = (persistence: SnapshotPersistence, info: SnapshotInfo): string =>
  join(snapshotStoreDir(persistence, info.store), `${info.id}.${info.format ?? "tar"}`);

const snapshotSidecarPath = (persistence: SnapshotPersistence, info: SnapshotInfo): string =>
  join(snapshotStoreDir(persistence, info.store), `${info.id}.json`);

const snapshotIndexEntryKey = (info: SnapshotInfo): string =>
  `${String(info.store.app)}:${info.store.store}:${info.id}`;

const openSnapshotIndex = (persistence: SnapshotPersistence, app: string) =>
  Effect.tryPromise({
    try: () => mkdir(snapshotAppDir(persistence, app), { recursive: true }),
    catch: (cause) => stateFailure("open", cause),
  }).pipe(
    Effect.zipRight(
      persistence.stateStore.open({
        root: { path: absolutePath(snapshotAppDir(persistence, app)) },
        key: "index.bin",
        schema: snapshotIndexSchema,
        version: 1,
        codec: "json",
        lock: "advisory",
        onCorrupt: "quarantine",
        default: [] as SnapshotIndex,
      }),
    ),
    Effect.mapError((cause) => (cause instanceof DataTransferError ? cause : stateFailure("open", cause))),
  );

const snapshotApps = (
  persistence: SnapshotPersistence,
  filter: SnapshotFilter,
): Effect.Effect<ReadonlyArray<string>> => {
  if (filter.app !== undefined) return Effect.succeed([String(filter.app)]);
  return Effect.tryPromise({
    try: () => readdir(persistence.paths.snapshotsDir),
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed([])));
};

const readSnapshotIndex = (persistence: SnapshotPersistence, app: string) =>
  openSnapshotIndex(persistence, app).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map((entries) => entries ?? []),
    Effect.mapError(
      (cause): DataTransferError =>
        cause instanceof DataTransferError ? cause : stateFailure("read-index", cause),
    ),
  );

const snapshotMatches = (info: SnapshotInfo, filter: SnapshotFilter): boolean => {
  if (filter.id !== undefined && info.id !== filter.id) return false;
  if (filter.app !== undefined && String(info.store.app) !== String(filter.app)) return false;
  if (filter.store !== undefined && info.store.store !== filter.store) return false;
  if (filter.scope !== undefined && info.store.scope !== filter.scope) return false;
  if (filter.label !== undefined && info.label !== filter.label) return false;
  if (filter.labels !== undefined) {
    for (const [key, value] of Object.entries(filter.labels)) {
      if (info.labels?.[key] !== value) return false;
    }
  }
  const created = Date.parse(DateTime.formatIso(info.createdAt));
  if (filter.createdAfter !== undefined && created <= Date.parse(DateTime.formatIso(filter.createdAfter)))
    return false;
  if (filter.createdBefore !== undefined && created >= Date.parse(DateTime.formatIso(filter.createdBefore)))
    return false;
  return true;
};

const listSnapshotInfos = (persistence: SnapshotPersistence, filter: SnapshotFilter) =>
  snapshotApps(persistence, filter).pipe(
    Effect.flatMap((apps) => Effect.forEach(apps, (app) => readSnapshotIndex(persistence, app))),
    Effect.map((groups) => groups.flat().filter((info) => snapshotMatches(info, filter))),
  );

const snapshotAmbiguous = (snapshotId: SnapshotId, matchCount: number): SnapshotAmbiguousError =>
  new SnapshotAmbiguousError({
    message: `Snapshot ${snapshotId} is ambiguous across ${matchCount} stores.`,
    snapshotId,
    matchCount,
    remediation: "Pass the snapshot handle or disambiguate with app and store when removing or restoring.",
  });

const findSnapshotInfo = (
  persistence: SnapshotPersistence,
  id: SnapshotId,
  store?: VolumeRef,
): Effect.Effect<SnapshotInfo, SnapshotNotFoundError | SnapshotAmbiguousError | DataTransferError> =>
  Effect.gen(function* () {
    const matches = yield* listSnapshotInfos(persistence, {
      id,
      ...(store === undefined ? {} : { app: store.app, store: store.store }),
    });
    if (matches.length === 0) return yield* Effect.fail(snapshotMissing(id, store));
    if (store === undefined && matches.length > 1) {
      return yield* Effect.fail(snapshotAmbiguous(id, matches.length));
    }
    const match = matches[0];
    if (match === undefined) return yield* Effect.fail(snapshotMissing(id, store));
    return match;
  });

const writeSnapshotSidecar = (persistence: SnapshotPersistence, info: SnapshotInfo) =>
  Schema.encodeUnknown(SnapshotInfoSchema)(info).pipe(
    Effect.mapError((cause) => stateFailure("encode-sidecar", cause)),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: async () => {
          const path = snapshotSidecarPath(persistence, info);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${JSON.stringify(encoded, null, 2)}\n`);
        },
        catch: (cause) => stateFailure("write-sidecar", cause),
      }),
    ),
  );

const upsertSnapshotInfo = (persistence: SnapshotPersistence, info: SnapshotInfo) =>
  openSnapshotIndex(persistence, String(info.store.app)).pipe(
    Effect.flatMap((bucket) => {
      const key = snapshotIndexEntryKey(info);
      return bucket.update((current) => [
        ...(current ?? []).filter((entry) => snapshotIndexEntryKey(entry) !== key),
        info,
      ]);
    }),
    Effect.mapError(
      (cause): DataTransferError =>
        cause instanceof DataTransferError ? cause : stateFailure("update-index", cause),
    ),
    Effect.asVoid,
  );

const removeSnapshotArtifacts = (persistence: SnapshotPersistence, info: SnapshotInfo) =>
  Effect.all(
    [
      Effect.tryPromise({
        try: () => Bun.file(snapshotSidecarPath(persistence, info)).delete(),
        catch: () => undefined,
      }),
      info.native === undefined
        ? Effect.tryPromise({
            try: () => Bun.file(snapshotArchivePath(persistence, info)).delete(),
            catch: () => undefined,
          })
        : Effect.void,
    ],
    { discard: true },
  );

const rollbackSnapshotPersistence = (
  provider: Context.Tag.Service<typeof RuntimeProvider>,
  persistence: SnapshotPersistence,
  info: SnapshotInfo | undefined,
  native: VolumeSnapshotRef | undefined,
) =>
  Effect.gen(function* () {
    if (info !== undefined) {
      yield* removeSnapshotArtifacts(persistence, info);
    }
    const removeNative = provider.removeVolumeSnapshot;
    if (native !== undefined && removeNative !== undefined) {
      yield* removeNative(native).pipe(
        Effect.mapError((cause) => providerFailure("removeVolumeSnapshot", cause)),
      );
    }
  });

const hashText = (value: string): string => createHash("sha256").update(value).digest("hex");

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
  eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
  redaction: Option.Option<Context.Tag.Service<typeof RedactionService>>,
): Effect.Effect<DataMoverEvents> => {
  const publish: DataMoverEvents["publish"] = Option.isSome(eventService)
    ? (event) => eventService.value.publish(event).pipe(Effect.catchAllCause(() => Effect.void))
    : () => Effect.void;

  if (Option.isNone(redaction)) return Effect.succeed({ ...noopEvents, publish });

  return redaction.value.forProfile("secrets").pipe(
    Effect.map((redactor) => ({ redactText: redactor.redactString, publish })),
    Effect.catchAll(() => Effect.succeed({ ...noopEvents, publish })),
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

export const __testOnlyEncodeTarOctal = octal;

const writeAscii = (target: Uint8Array, offset: number, value: string, length: number) => {
  const bytes = new TextEncoder().encode(value.slice(0, length));
  target.set(bytes, offset);
};

const packTar = (payload: Uint8Array): Uint8Array => {
  const header = new Uint8Array(512);
  writeAscii(header, 0, "payload", 100);
  writeAscii(header, 100, `${octal(0o644, 8)}\0`, 8);
  writeAscii(header, 108, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 116, `${octal(0, 8)}\0`, 8);
  writeAscii(header, 124, `${octal(payload.byteLength, 12)}\0`, 12);
  writeAscii(header, 136, `${octal(0, 12)}\0`, 12);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, "0", 1);
  writeAscii(header, 257, "ustar", 6);
  writeAscii(header, 263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, `${octal(checksum, 7)}\0 `, 8);

  const paddedSize = Math.ceil(payload.byteLength / 512) * 512;
  const archive = new Uint8Array(512 + paddedSize + 1024);
  archive.set(header, 0);
  archive.set(payload, 512);
  return archive;
};

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

const webStreamBytes = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const compressionFormat = (format: "tar.gz" | "tar.zst") => (format === "tar.gz" ? "gzip" : "zstd");

const archivePayload = (
  payload: Uint8Array,
  format: "tar" | "tar.gz" | "tar.zst",
): Effect.Effect<Uint8Array, ArchiveFormatError> => {
  const tar = Effect.try({
    try: () => packTar(payload),
    catch: (cause) =>
      cause instanceof ArchiveFormatError
        ? cause
        : new ArchiveFormatError({
            message: "Failed to encode host archive endpoint.",
            format: "tar",
            cause,
            remediation: "Retry the transfer or choose a different archive format.",
          }),
  });
  switch (format) {
    case "tar":
      return tar;
    case "tar.gz":
    case "tar.zst":
      return tar.pipe(
        Effect.flatMap((archive) =>
          Effect.tryPromise({
            try: () =>
              webStreamBytes(
                new Blob([archive]).stream().pipeThrough(new CompressionStream(compressionFormat(format))),
              ),
            catch: (cause) =>
              new ArchiveFormatError({
                message: "Failed to encode host archive endpoint.",
                format,
                cause,
                remediation: "Retry the transfer or choose a different archive format.",
              }),
          }),
        ),
      );
  }
};

const unarchivePayload = (
  payload: Uint8Array,
  format: "tar" | "tar.gz" | "tar.zst",
  path: string,
): Effect.Effect<Uint8Array, ArchiveFormatError> => {
  switch (format) {
    case "tar":
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
            await webStreamBytes(
              new Blob([payload]).stream().pipeThrough(new DecompressionStream(compressionFormat(format))),
            ),
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

const serviceCommandFailure = (operation: string, cause: unknown): DataTransferError =>
  new DataTransferError({
    message: `Service command ${operation} failed during data transfer.`,
    operation,
    cause,
    remediation: "Inspect the service command and retry after the service is healthy.",
  });

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
  let candidate = path;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`No existing ancestor for ${path}`);
      candidate = parent;
    }
  }
};

const resolveAppRoot = async (paths: ReadonlyArray<string>): Promise<string> => {
  const cwdRoot = await findAppRoot(process.cwd());
  if (cwdRoot !== undefined) return realpath(cwdRoot);

  for (const path of paths) {
    const endpointRoot = await findAppRoot(path);
    if (endpointRoot !== undefined) return realpath(endpointRoot);
  }

  return realpath(process.cwd());
};

const ensureInsideRoot = (path: string, root: string) =>
  Effect.gen(function* () {
    const normalized = resolve(path);
    const relativeNormalized = relative(root, normalized);
    if (relativeNormalized.startsWith("..") || isAbsolute(relativeNormalized)) {
      return yield* Effect.fail(
        new DataSourceOutsideRootError({
          message: "Host data endpoint escapes the permitted app root.",
          path,
          base: root,
          remediation:
            "Move the source/destination inside the app root or use an explicitly trusted endpoint.",
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
    const relativeToRoot = relative(root, existing);
    if (relativeToRoot === "" || (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))) return;
    return yield* Effect.fail(
      new DataSourceOutsideRootError({
        message: "Host data endpoint escapes the permitted app root.",
        path,
        base: root,
        remediation: "Move the source/destination inside the app root or use an explicitly trusted endpoint.",
      }),
    );
  });

const validateHostEndpoints = (spec: DataTransferSpec) => {
  const endpoints = [spec.from, spec.to].filter(
    (endpoint): endpoint is Extract<DataEndpoint, { readonly _tag: "hostPath" | "hostArchive" }> =>
      endpoint._tag === "hostPath" || endpoint._tag === "hostArchive",
  );
  if (endpoints.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => resolveAppRoot(endpoints.map((endpoint) => endpoint.path)),
      catch: () =>
        new DataSourceOutsideRootError({
          message: "Failed to resolve the app root for data endpoint validation.",
          path: endpoints[0]?.path ?? process.cwd(),
        }),
    });
    yield* Effect.all(
      endpoints.map((endpoint) => ensureInsideRoot(endpoint.path, root)),
      { discard: true },
    );
  });
};

const byteStreamFromHost = (path: string): Stream.Stream<Uint8Array, DataTransferError> =>
  Stream.unwrap(
    Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) =>
        new DataTransferError({
          message: "Failed to read host data endpoint.",
          fromEndpoint: `hostPath:${path}`,
          operation: "read-host",
          cause,
        }),
    }).pipe(Effect.map((payload) => Stream.make(new Uint8Array(payload)))),
  );

const byteStreamFromArchive = (
  path: string,
  format: "tar" | "tar.gz" | "tar.zst",
): Stream.Stream<Uint8Array, DataTransferError | ArchiveFormatError> =>
  Stream.unwrap(
    Effect.tryPromise({
      try: () => readFile(path),
      catch: (cause) =>
        new DataTransferError({
          message: "Failed to read host archive endpoint.",
          fromEndpoint: `hostArchive:${format}:${path}`,
          operation: "read-host-archive",
          cause,
        }),
    }).pipe(
      Effect.flatMap((payload) => unarchivePayload(new Uint8Array(payload), format, path)),
      Effect.map((payload) => Stream.make(payload)),
    ),
  );

const collectByteStream = <E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Uint8Array, E, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      const collected = Array.from(chunks);
      const out = new Uint8Array(collected.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of collected) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }),
  );

const asyncIterableFromBytes = (payload: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield payload;
  },
});

const collectExecStdout = <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
): Effect.Effect<Uint8Array, E | DataTransferError, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.flatMap((chunks) => {
      const collected = Array.from(chunks);
      const exit = collected.find((chunk): chunk is { readonly exitCode: number } => "exitCode" in chunk);
      if (exit !== undefined && exit.exitCode !== 0) {
        return Effect.fail(
          new DataTransferError({
            message: "Generic helper-container data transfer failed.",
            operation: "runStream",
            cause: exit,
            remediation: "Inspect provider logs and retry after the provider runtime is healthy.",
          }),
        );
      }
      const total = collected.reduce(
        (size, chunk) => size + ("kind" in chunk && chunk.kind === "stdout" ? chunk.chunk.byteLength : 0),
        0,
      );
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of collected) {
        if (!("kind" in chunk) || chunk.kind !== "stdout") continue;
        out.set(chunk.chunk, offset);
        offset += chunk.chunk.byteLength;
      }
      return Effect.succeed(out);
    }),
  );

const streamFromEndpoint = (
  provider: Context.Tag.Service<typeof RuntimeProvider>,
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
        collectExecStdout(
          provider.runStream({
            image: "lando-data-helper",
            command: ["sh", "-c", `cat ${helperPayload}`],
            mounts: [{ store: endpoint.store, target: helperTarget, readOnly: true }],
            remove: true,
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof DataTransferError ? cause : providerFailure("runStream", cause),
          ),
          Effect.map((payload) => Stream.make(payload)),
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
      return Stream.unwrap(
        collectExecStdout(
          provider.execStream(
            { app: endpoint.app, service: endpoint.service },
            providerCommandSpec(endpoint.command, endpoint.env),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof DataTransferError ? cause : serviceCommandFailure("execStream", cause),
          ),
          Effect.map((payload) => Stream.make(payload)),
        ),
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

const writeStreamToEndpoint = (
  provider: Context.Tag.Service<typeof RuntimeProvider>,
  spec: DataTransferSpec,
  body: Stream.Stream<
    Uint8Array,
    ArchiveFormatError | DataTransferError | DataEndpointUnsupportedError,
    Scope.Scope
  >,
): Effect.Effect<DataTransferResult, DataMoverTransferError, Scope.Scope> => {
  const target = spec.to;
  switch (target._tag) {
    case "hostPath":
      return Effect.gen(function* () {
        const payload = yield* collectByteStream(body);
        const result = yield* persistVerifiedStream({
          body: Stream.make(payload),
          destinationPath: target.path,
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        return { accelerated: false, sizeBytes: result.sizeBytes, digest: result.sha256 };
      });
    case "hostArchive":
      return Effect.gen(function* () {
        const payload = yield* collectByteStream(body);
        const verified = yield* collectVerifiedStream({
          body: Stream.make(payload),
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        const archive = yield* archivePayload(payload, target.format);
        yield* persistVerifiedStream({
          body: Stream.make(archive),
          destinationPath: target.path,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        return { accelerated: false, sizeBytes: verified.sizeBytes, digest: verified.sha256 };
      });
    case "servicePath":
      if (provider.capabilities.serviceFileCopy !== "native")
        return failUnsupported(spec.from, target, "native service file copy is unavailable");
      return Effect.gen(function* () {
        const payload = yield* collectByteStream(body);
        const verified = yield* collectVerifiedStream({
          body: Stream.make(payload),
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        const tempPath = `${process.cwd()}/.tmp-data-mover-service-${randomUUID()}`;
        yield* Effect.addFinalizer(() => Effect.promise(() => unlink(tempPath).catch(() => undefined)));
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(tempPath), { recursive: true });
            await Bun.write(tempPath, payload);
          },
          catch: (cause) =>
            new DataTransferError({
              message: "Failed to stage service copy payload.",
              operation: "stage-service-copy",
              cause,
            }),
        });
        yield* provider
          .copyToService(
            { app: target.app, service: target.service },
            { sourcePath: absolutePath(tempPath), targetPath: target.path, overwrite: spec.overwrite },
          )
          .pipe(Effect.mapError((cause) => providerFailure("copyToService", cause)));
        return { accelerated: true, sizeBytes: verified.sizeBytes, digest: verified.sha256 };
      });
    case "volume":
      if (!provider.capabilities.ephemeralMounts)
        return failUnsupported(spec.from, target, "ephemeral mounts are unavailable");
      return Effect.gen(function* () {
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
        const payload = yield* collectByteStream(body);
        const verified = yield* collectVerifiedStream({
          body: Stream.make(payload),
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        const result = yield* provider
          .run({
            image: "lando-data-helper",
            command: ["sh", "-c", `cat > ${helperPayload}`],
            mounts: [{ store: target.store, target: helperTarget, readOnly: false }],
            stdinStream: asyncIterableFromBytes(payload),
            remove: true,
          })
          .pipe(Effect.mapError((cause) => providerFailure("run", cause)));
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new DataTransferError({
              message: "Generic helper-container import failed.",
              operation: "run",
              cause: result,
            }),
          );
        }
        return { accelerated: false, sizeBytes: verified.sizeBytes, digest: verified.sha256 };
      });
    case "artifact":
      if (!provider.capabilities.artifactImport)
        return failUnsupported(spec.from, target, "artifact import is unavailable");
      return Effect.gen(function* () {
        const payload = yield* collectByteStream(body);
        const verified = yield* collectVerifiedStream({
          body: Stream.make(payload),
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        yield* provider
          .importArtifact(Stream.make(payload))
          .pipe(Effect.mapError((cause) => providerFailure("importArtifact", cause)));
        return { accelerated: true, sizeBytes: verified.sizeBytes, digest: verified.sha256 };
      });
    case "serviceCmd":
      return Effect.gen(function* () {
        const payload = yield* collectByteStream(body);
        const verified = yield* collectVerifiedStream({
          body: Stream.make(payload),
          expectedSha256: spec.expectedDigest,
        }).pipe(Effect.mapError((error) => mapVerifiedError(error, spec)));
        const result = yield* provider
          .exec(
            { app: target.app, service: target.service },
            {
              ...providerCommandSpec(target.command, target.env),
              stdinStream: asyncIterableFromBytes(payload),
            },
          )
          .pipe(Effect.mapError((cause) => serviceCommandFailure("exec", cause)));
        if (result.exitCode !== 0) {
          return yield* Effect.fail(serviceCommandFailure("exec", result));
        }
        return { accelerated: true, sizeBytes: verified.sizeBytes, digest: verified.sha256 };
      });
    case "stream":
      return failUnsupported(
        spec.from,
        target,
        `endpoint ${target._tag} cannot be used as an implicit transfer target`,
      );
  }
};

const failureDetail = (cause: Cause.Cause<unknown>): string => {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (typeof failure === "object" && failure !== null && "_tag" in failure)
    return String((failure as { _tag: string })._tag);
  if (Cause.isInterrupted(cause)) return "interrupted";
  return "error";
};

export const makeDataMoverService = (
  provider: Context.Tag.Service<typeof RuntimeProvider>,
  events: DataMoverEvents,
  persistence: SnapshotPersistence,
): Context.Tag.Service<typeof DataMover> => ({
  transfer: (spec) => {
    const startedAt = Date.now();
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
      timestamp: timestamp(),
    });

    const run = Effect.gen(function* () {
      yield* validateHostEndpoints(spec);
      const nativeServiceCopy =
        provider.capabilities.serviceFileCopy === "native" &&
        ((spec.from._tag === "hostPath" && spec.to._tag === "servicePath") ||
          (spec.from._tag === "servicePath" &&
            (spec.to._tag === "hostPath" || spec.to._tag === "hostArchive")));
      const body = streamFromEndpoint(provider, spec.from);
      const result = yield* writeStreamToEndpoint(provider, spec, body);
      const adjusted = nativeServiceCopy ? { ...result, accelerated: true } : result;
      const progress: DataTransferProgress = {
        phase: "completed",
        transferredBytes: adjusted.sizeBytes ?? 0,
        digest: adjusted.digest,
      };
      yield* events.publish(
        DataTransferProgressEvent.make({
          eventName: "data-transfer-progress",
          fromEndpoint,
          toEndpoint,
          transferredBytes: progress.transferredBytes,
          ...(progress.digest === undefined ? {} : { digest: progress.digest }),
          timestamp: timestamp(),
        }),
      );
      return adjusted;
    });

    return events.publish(pre).pipe(
      Effect.zipRight(run),
      Effect.tap((result) =>
        events.publish(
          PostDataTransferEvent.make({
            eventName: "post-data-transfer",
            fromEndpoint,
            toEndpoint,
            outcome: "success",
            accelerated: result.accelerated,
            ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
            ...(result.digest === undefined ? {} : { digest: result.digest }),
            durationMs: Date.now() - startedAt,
            timestamp: timestamp(),
          }),
        ),
      ),
      Effect.tapErrorCause((cause) =>
        events.publish(
          PostDataTransferEvent.make({
            eventName: "post-data-transfer",
            fromEndpoint,
            toEndpoint,
            outcome: "failure",
            accelerated: false,
            failureDetail: events.redactText(failureDetail(cause)),
            durationMs: Date.now() - startedAt,
            timestamp: timestamp(),
          }),
        ),
      ),
    );
  },
  transferStream: (spec) =>
    Stream.concat(
      Stream.make({ phase: "started" as const, transferredBytes: 0 }),
      Stream.unwrap(
        makeDataMoverService(provider, events, persistence)
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
  snapshot: (store, opts) => {
    const snapshotId = opts?.label ?? `${store.store}-${randomUUID()}`;
    let rollbackInfo: SnapshotInfo | undefined;
    let rollbackNative: VolumeSnapshotRef | undefined;
    return Effect.gen(function* () {
      yield* events.publish(
        PreVolumeSnapshotEvent.make({
          eventName: "pre-volume-snapshot",
          volume: store,
          ...(opts?.format === undefined ? {} : { format: opts.format }),
          timestamp: timestamp(),
        }),
      );
      const createdAt = timestamp();
      const useNative =
        opts?.volumeSnapshot === "native" ||
        (opts?.volumeSnapshot !== "copy" && provider.capabilities.volumeSnapshot === "native");
      const format = opts?.format ?? "tar";
      const native: VolumeSnapshotRef | undefined = useNative
        ? yield* provider
            .snapshotVolume({ volume: store, snapshotId, label: opts?.label, labels: opts?.labels })
            .pipe(Effect.mapError((cause) => providerFailure("snapshotVolume", cause)))
        : undefined;
      rollbackNative = native;
      const copyResult =
        native === undefined
          ? yield* writeStreamToEndpoint(
              provider,
              {
                from: { _tag: "volume", app: store.app, store: store.store },
                to: {
                  _tag: "hostArchive",
                  path: absolutePath(join(snapshotStoreDir(persistence, store), `${snapshotId}.${format}`)),
                  format,
                },
                overwrite: true,
              },
              streamFromEndpoint(provider, { _tag: "volume", app: store.app, store: store.store }),
            )
          : undefined;
      const nativeDigest = native === undefined ? undefined : hashText(JSON.stringify(native));
      const info: SnapshotInfo = {
        id: snapshotId,
        store,
        digest: copyResult?.digest ?? nativeDigest ?? hashText(snapshotId),
        sizeBytes: copyResult?.sizeBytes ?? 0,
        createdAt,
        ...(native === undefined ? { format } : { native }),
        ...(opts?.label === undefined ? {} : { label: opts.label }),
        ...(opts?.labels === undefined ? {} : { labels: opts.labels }),
      };
      rollbackInfo = info;
      yield* writeSnapshotSidecar(persistence, info);
      yield* upsertSnapshotInfo(persistence, info);
      yield* events.publish(
        PostVolumeSnapshotEvent.make({
          eventName: "post-volume-snapshot",
          volume: store,
          snapshotId,
          outcome: "success",
          timestamp: timestamp(),
        }),
      );
      return { id: snapshotId, store };
    }).pipe(
      Effect.tapError(() =>
        rollbackInfo === undefined && rollbackNative === undefined
          ? Effect.void
          : rollbackSnapshotPersistence(provider, persistence, rollbackInfo, rollbackNative).pipe(
              Effect.catchAll(() => Effect.void),
            ),
      ),
      Effect.tapErrorCause((cause) =>
        events.publish(
          PostVolumeSnapshotEvent.make({
            eventName: "post-volume-snapshot",
            volume: store,
            snapshotId,
            outcome: "failure",
            failureDetail: events.redactText(failureDetail(cause)),
            timestamp: timestamp(),
          }),
        ),
      ),
    );
  },
  restore: (handle, store) =>
    findSnapshotInfo(
      persistence,
      typeof handle === "string" ? handle : handle.id,
      typeof handle === "string" ? store : handle.store,
    ).pipe(
      Effect.flatMap((info) =>
        info.native === undefined
          ? writeStreamToEndpoint(
              provider,
              {
                from: {
                  _tag: "hostArchive",
                  path: absolutePath(snapshotArchivePath(persistence, info)),
                  format: info.format ?? "tar",
                },
                to: { _tag: "volume", app: store.app, store: store.store },
                expectedDigest: info.digest,
                overwrite: true,
              },
              streamFromEndpoint(provider, {
                _tag: "hostArchive",
                path: absolutePath(snapshotArchivePath(persistence, info)),
                format: info.format ?? "tar",
              }),
            ).pipe(Effect.asVoid)
          : provider
              .restoreVolume({ snapshot: info.native, target: store, overwrite: true })
              .pipe(Effect.mapError((cause) => providerFailure("restoreVolume", cause))),
      ),
    ),
  listSnapshots: (filter) => listSnapshotInfos(persistence, filter),
  removeSnapshot: (id, store) =>
    findSnapshotInfo(persistence, id, store).pipe(
      Effect.flatMap((info) =>
        openSnapshotIndex(persistence, String(info.store.app)).pipe(
          Effect.flatMap((bucket) => {
            const key = snapshotIndexEntryKey(info);
            return bucket.update((current) =>
              (current ?? []).filter((entry) => snapshotIndexEntryKey(entry) !== key),
            );
          }),
          Effect.zipRight(removeSnapshotArtifacts(persistence, info)),
          Effect.flatMap(() => {
            const removeNative = provider.removeVolumeSnapshot;
            if (info.native === undefined || removeNative === undefined) {
              return Effect.void;
            }
            return Effect.scoped(
              removeNative(info.native).pipe(
                Effect.mapError((cause) => providerFailure("removeVolumeSnapshot", cause)),
              ),
            );
          }),
          Effect.mapError(
            (cause): DataTransferError =>
              cause instanceof DataTransferError ? cause : stateFailure("remove", cause),
          ),
        ),
      ),
    ),
  pruneSnapshots: (policy: PrunePolicy) =>
    listSnapshotInfos(persistence, policy.filter ?? {}).pipe(
      Effect.map((infos) => {
        if (policy.keepLatest === undefined) {
          return [];
        }
        return [...infos]
          .sort(
            (left, right) =>
              Date.parse(DateTime.formatIso(right.createdAt)) -
              Date.parse(DateTime.formatIso(left.createdAt)),
          )
          .slice(policy.keepLatest);
      }),
      Effect.flatMap((remove) =>
        Effect.forEach(remove, (info) =>
          makeDataMoverService(provider, events, persistence)
            .removeSnapshot(info.id, info.store)
            .pipe(Effect.as(info.id)),
        ),
      ),
    ),
});

export const DataMoverLive: Layer.Layer<
  DataMover,
  never,
  RuntimeProvider | PathsService | StateStore | EventService | RedactionService
> = Layer.suspend(() =>
  Layer.effect(
    DataMover,
    Effect.gen(function* () {
      const provider = yield* RuntimeProvider;
      const paths = yield* PathsService;
      const stateStore = yield* StateStore;
      const eventService = yield* Effect.serviceOption(EventService);
      const redaction = yield* Effect.serviceOption(RedactionService);
      const events = yield* makeEvents(eventService, redaction);
      return makeDataMoverService(provider, events, { paths, stateStore });
    }),
  ),
);
