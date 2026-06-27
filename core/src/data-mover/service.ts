import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Cause, type Context, DateTime, Effect, Layer, Option, Schema, type Scope, Stream } from "effect";

import {
  ArchiveFormatError,
  DataChecksumMismatchError,
  DataEndpointUnsupportedError,
  DataSourceOutsideRootError,
  DataTargetExistsError,
  DataTransferError,
  ProviderUnavailableError,
  VolumeNotFoundError,
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
} from "@lando/sdk/schema";
import { DataMover, EventService, type ExecChunk, RuntimeProvider } from "@lando/sdk/services";
import {
  type VerifiedStreamError,
  collectVerifiedStream,
  persistVerifiedStream,
} from "@lando/sdk/verified-stream";
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

const noopEvents: DataMoverEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

const helperTarget = Schema.decodeUnknownSync(PortablePath)("/data");
const helperPayload = Schema.decodeUnknownSync(PortablePath)("/data/payload");
const timestamp = () => DateTime.unsafeMake(Date.now());

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

const octal = (value: number, width: number): string =>
  value
    .toString(8)
    .padStart(width - 1, "0")
    .slice(0, width - 1);

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
  const tar = packTar(payload);
  switch (format) {
    case "tar":
      return Effect.succeed(tar);
    case "tar.gz":
    case "tar.zst":
      return Effect.tryPromise({
        try: () =>
          webStreamBytes(
            new Blob([tar]).stream().pipeThrough(new CompressionStream(compressionFormat(format))),
          ),
        catch: (cause) =>
          new ArchiveFormatError({
            message: "Failed to encode host archive endpoint.",
            format,
            cause,
            remediation: "Retry the transfer or choose a different archive format.",
          }),
      });
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

const ensureInsideRoot = (path: string) =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => realpath(process.cwd()),
      catch: () =>
        new DataSourceOutsideRootError({
          message: "Failed to resolve the app root for data endpoint validation.",
          path,
        }),
    });
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

const validateHostEndpoints = (spec: DataTransferSpec) =>
  Effect.all(
    [spec.from, spec.to].flatMap((endpoint) => {
      if (endpoint._tag === "hostPath" || endpoint._tag === "hostArchive")
        return [ensureInsideRoot(endpoint.path)];
      return [];
    }),
    { discard: true },
  );

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
  events: DataMoverEvents = noopEvents,
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
        makeDataMoverService(provider, events)
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
  snapshot: (store, opts) =>
    Effect.gen(function* () {
      const snapshotId = opts?.label ?? `${store.store}-${randomUUID()}`;
      return yield* Effect.gen(function* () {
        yield* events.publish(
          PreVolumeSnapshotEvent.make({
            eventName: "pre-volume-snapshot",
            volume: store,
            ...(opts?.format === undefined ? {} : { format: opts.format }),
            timestamp: timestamp(),
          }),
        );
        yield* provider
          .snapshotVolume({ volume: store, snapshotId, label: opts?.label, labels: opts?.labels })
          .pipe(Effect.mapError((cause) => providerFailure("snapshotVolume", cause)));
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
    }),
  restore: (handle, store) =>
    typeof handle === "string"
      ? Effect.fail(
          new VolumeNotFoundError({
            message: "String snapshot handles require the durable snapshot store from the next story.",
            store: store.store,
            app: store.app,
          }),
        )
      : provider
          .restoreVolume({
            snapshot: { provider: provider.id, id: handle.id },
            target: store,
            overwrite: true,
          })
          .pipe(Effect.mapError((cause) => providerFailure("restoreVolume", cause))),
  listSnapshots: () => Effect.succeed([]),
  removeSnapshot: () => Effect.void,
  pruneSnapshots: () => Effect.succeed([]),
});

export const DataMoverLive: Layer.Layer<DataMover, never, RuntimeProvider | EventService | RedactionService> =
  Layer.suspend(() =>
    Layer.effect(
      DataMover,
      Effect.gen(function* () {
        const provider = yield* RuntimeProvider;
        const eventService = yield* Effect.serviceOption(EventService);
        const redaction = yield* Effect.serviceOption(RedactionService);
        const events = yield* makeEvents(eventService, redaction);
        return makeDataMoverService(provider, events);
      }),
    ),
  );
