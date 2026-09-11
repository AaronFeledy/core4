import { readFile } from "node:fs/promises";

// The scratch registry — a thin, scratch-shaped view over a single durable
// `StateBucket`. All atomic write, advisory cross-process locking, corruption
// quarantine, and version-envelope handling are delegated to `StateStore`
// (`core/src/state/`); this module only owns the scratch entry schema and the
// `read`/`upsert`/`remove`/`list`/`get` surface its callers expect. The live
// layer derives private-file access from the process runner before opening the
// bucket so Windows ACL enforcement never relies on an ambient subprocess path.

import { Context, Effect, Layer, Schema } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import type { StateStoreError } from "@lando/sdk/errors";
import { ProcessRunner, type StateBucket } from "@lando/sdk/services";

import { makeLandoPaths } from "@lando/paths";
import { writeFileAtomicScoped } from "@lando/state-store/atomic";
import { encodeFrame } from "@lando/state-store/codec";
import { acquireAdvisoryLockAt, withAdvisoryLockUsing } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import { type PrivateFileAccess, makeOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";

const REGISTRY_VERSION = 1 as const;

const ScratchSourceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("fork") }),
  Schema.Struct({ kind: Schema.Literal("recipe"), ref: Schema.String }),
);

const RegistryEntrySchema = Schema.Struct({
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literal("full", "baked", "cwd"),
  detached: Schema.Boolean,
  ownerPid: Schema.optional(Schema.Number),
  rootPath: Schema.String,
  status: Schema.Literal("acquiring", "running", "stopping", "destroyed-pending-cleanup"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const LegacyRegistryEntrySchema = Schema.Struct({
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literal("none", "full", "baked", "cwd"),
  detached: Schema.Boolean,
  ownerPid: Schema.optional(Schema.Number),
  rootPath: Schema.String,
  status: Schema.Literal("acquiring", "running", "stopping", "destroyed-pending-cleanup"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const RegistryEntriesSchema = Schema.Array(RegistryEntrySchema);
const LegacyRegistryEntriesSchema = Schema.Array(LegacyRegistryEntrySchema);

const RegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  entries: RegistryEntriesSchema,
});

const LegacyRegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  entries: LegacyRegistryEntriesSchema,
});

const LegacyStateFrameSchema = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  data: LegacyRegistryEntriesSchema,
});

export type ScratchRegistryEntry = typeof RegistryEntrySchema.Type;
export type ScratchRegistryEnvelope = typeof RegistryEnvelopeSchema.Type;

type RegistryEntries = ReadonlyArray<ScratchRegistryEntry>;

export interface ScratchRegistryPaths {
  readonly base: string;
  readonly registry: string;
  readonly lock: string;
}

export const scratchRegistryPaths = (): ScratchRegistryPaths => {
  const paths = makeLandoPaths();
  return {
    base: paths.scratchDir,
    registry: paths.scratchRegistryFile,
    lock: paths.scratchRegistryLockFile,
  };
};

const scratchRegistryError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({
    operation,
    message,
    cause,
    ...(typeof cause === "object" &&
    cause !== null &&
    "remediation" in cause &&
    typeof cause.remediation === "string"
      ? { remediation: cause.remediation }
      : {}),
  });

const sortById = (entries: RegistryEntries): RegistryEntries =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { readonly code?: unknown }).code === "ENOENT";

const decodeLegacyEnvelope = (content: string): RegistryEntries | null => {
  try {
    const parsed = JSON.parse(content) as unknown;
    const entries = Schema.decodeUnknownSync(LegacyRegistryEnvelopeSchema)(parsed, {
      onExcessProperty: "error",
    }).entries;
    return entries.map((entry) => ({
      ...entry,
      isolate: entry.isolate === "none" ? (entry.source.kind === "fork" ? "cwd" : "baked") : entry.isolate,
    }));
  } catch {
    try {
      const entries = Schema.decodeUnknownSync(LegacyStateFrameSchema)(JSON.parse(content), {
        onExcessProperty: "error",
      }).data;
      if (!entries.some((entry) => entry.isolate === "none")) return null;
      return entries.map((entry) => ({
        ...entry,
        isolate: entry.isolate === "none" ? (entry.source.kind === "fork" ? "cwd" : "baked") : entry.isolate,
      }));
    } catch {
      return null;
    }
  }
};

const migrateLegacyEnvelope = (privateFileAccess: PrivateFileAccess): Effect.Effect<void, ScratchAppError> =>
  resolveStatePath("userCache", "scratch", "registry.bin", "registry.migrate").pipe(
    Effect.mapError((cause) =>
      scratchRegistryError("registry.migrate", "Unable to migrate the scratch registry.", cause),
    ),
    Effect.flatMap(({ file: registryFile }) => {
      const inspectLegacyEnvelope = Effect.promise(async () => {
        try {
          return decodeLegacyEnvelope(await readFile(registryFile, "utf8"));
        } catch (cause) {
          if (isMissing(cause)) return null;
          return null;
        }
      });

      const rewriteLegacyEnvelope = (entries: RegistryEntries) =>
        Schema.encode(RegistryEntriesSchema)(entries).pipe(
          Effect.map((encoded) => encodeFrame("json", REGISTRY_VERSION, encoded, entries)),
          Effect.flatMap((body) =>
            writeFileAtomicScoped(registryFile, body, {
              mode: 0o600,
              privateFileAccess: privateFileAccess.enforce,
            }),
          ),
          Effect.mapError((cause) =>
            scratchRegistryError("registry.migrate", "Unable to migrate the scratch registry.", cause),
          ),
        );

      return withAdvisoryLockUsing(privateFileAccess)(
        registryFile,
        "registry.migrate",
        inspectLegacyEnvelope.pipe(
          Effect.flatMap((entries) => (entries === null ? Effect.void : rewriteLegacyEnvelope(entries))),
        ),
      );
    }),
    Effect.mapError((cause) =>
      cause instanceof ScratchAppError
        ? cause
        : scratchRegistryError("registry.migrate", "Unable to migrate the scratch registry.", cause),
    ),
  );

/**
 * Re-acquire the legacy `registry.lock` advisory lock via the generic state
 * lock primitive. The scratch registry's mutations are now serialized by the
 * bucket's own advisory lock (`registry.bin.lock`); this helper is retained as a
 * thin delegation to the shared lock so callers that held the explicit lock
 * handle keep working with the same token-checked release semantics.
 */
export const acquireScratchRegistryLock = (
  paths: ScratchRegistryPaths = scratchRegistryPaths(),
  privateFileAccess: PrivateFileAccess = makeOwnerOnlyFileAccess(),
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, ScratchAppError> =>
  acquireAdvisoryLockAt(paths.lock, "registry.lock", { privateFileAccess }).pipe(
    Effect.mapError((cause) =>
      scratchRegistryError("registry.lock", "Unable to acquire the scratch registry lock.", cause),
    ),
  );

export interface ScratchRegistryService {
  readonly read: () => Effect.Effect<ScratchRegistryEnvelope, ScratchAppError>;
  readonly upsert: (entry: ScratchRegistryEntry) => Effect.Effect<void, ScratchAppError>;
  readonly remove: (id: string) => Effect.Effect<void, ScratchAppError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ScratchRegistryEntry>, ScratchAppError>;
  readonly get: (id: string) => Effect.Effect<ScratchRegistryEntry | undefined, ScratchAppError>;
}

export class ScratchRegistry extends Context.Tag("@lando/core/ScratchRegistry")<
  ScratchRegistry,
  ScratchRegistryService
>() {}

const openRegistryBucket = (
  privateFileAccess: PrivateFileAccess,
): Effect.Effect<StateBucket<RegistryEntries>, ScratchAppError> =>
  makeStateStore({ privateFileAccess })
    .open<RegistryEntries, RegistryEntries>({
      root: "userCache",
      namespace: "scratch",
      key: "registry.bin",
      schema: RegistryEntriesSchema,
      version: REGISTRY_VERSION,
      mode: 0o600,
      codec: "json",
      lock: "advisory",
      onCorrupt: "quarantine",
      default: [],
    })
    .pipe(
      Effect.mapError((cause) =>
        scratchRegistryError("registry.open", "Unable to open the scratch registry.", cause),
      ),
    );

export const makeScratchRegistry = (
  privateFileAccess: PrivateFileAccess = makeOwnerOnlyFileAccess(),
): ScratchRegistryService => {
  const withBucket = <A>(
    operation: string,
    message: string,
    use: (bucket: StateBucket<RegistryEntries>) => Effect.Effect<A, StateStoreError>,
  ): Effect.Effect<A, ScratchAppError> =>
    migrateLegacyEnvelope(privateFileAccess).pipe(
      Effect.zipRight(
        openRegistryBucket(privateFileAccess).pipe(
          Effect.flatMap((bucket) =>
            use(bucket).pipe(Effect.mapError((cause) => scratchRegistryError(operation, message, cause))),
          ),
        ),
      ),
    );

  const readEntries = (operation: string, message: string): Effect.Effect<RegistryEntries, ScratchAppError> =>
    withBucket(operation, message, (bucket) => bucket.get.pipe(Effect.map((entries) => entries ?? [])));

  const read = () =>
    readEntries("registry.read", "Unable to read the scratch registry.").pipe(
      Effect.map((entries) => ({ version: REGISTRY_VERSION, entries }) satisfies ScratchRegistryEnvelope),
    );

  const list = () => readEntries("registry.read", "Unable to read the scratch registry.");

  const get = (id: string) => list().pipe(Effect.map((entries) => entries.find((entry) => entry.id === id)));

  const upsert = (entry: ScratchRegistryEntry) =>
    withBucket("registry.write", "Unable to write the scratch registry.", (bucket) =>
      bucket.update((current) =>
        sortById([...(current ?? []).filter((existing) => existing.id !== entry.id), entry]),
      ),
    ).pipe(Effect.asVoid);

  const remove = (id: string) =>
    withBucket("registry.write", "Unable to write the scratch registry.", (bucket) =>
      bucket.update((current) => (current ?? []).filter((entry) => entry.id !== id)),
    ).pipe(Effect.asVoid);

  return { read, upsert, remove, list, get };
};

export const ScratchRegistryLive = Layer.succeed(ScratchRegistry, makeScratchRegistry());

export const ScratchRegistryWithProcessRunnerLive: Layer.Layer<ScratchRegistry, never, ProcessRunner> =
  Layer.effect(
    ScratchRegistry,
    Effect.map(ProcessRunner, (processRunner) =>
      makeScratchRegistry(makeOwnerOnlyFileAccess({ processRunner })),
    ),
  );
