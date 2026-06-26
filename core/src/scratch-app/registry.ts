import { readFile } from "node:fs/promises";

// The scratch registry — a thin, scratch-shaped view over a single durable
// `StateBucket`. All atomic write, advisory cross-process locking, corruption
// quarantine, and version-envelope handling are delegated to `StateStore`
// (`core/src/state/`); this module only owns the scratch entry schema and the
// `read`/`upsert`/`remove`/`list`/`get` surface its callers expect. The bucket
// is opened from the dependency-free `makeStateStore()` factory (the same value
// `StateStoreLive` wraps) so `makeScratchRegistry()` stays a zero-arg synchronous
// constructor usable without a `StateStore` service in context.

import { Context, Effect, Layer, Schema } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import type { StateStoreError } from "@lando/sdk/errors";
import type { StateBucket } from "@lando/sdk/services";

import { makeLandoPaths } from "../config/paths.ts";
import { writeFileAtomicScoped } from "../state-store/atomic.ts";
import { encodeFrame } from "../state/codec.ts";
import { acquireAdvisoryLockAt, withAdvisoryLock } from "../state/lock.ts";
import { makeStateStore } from "../state/service.ts";

const REGISTRY_VERSION = 1 as const;

const ScratchSourceSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("fork") }),
  Schema.Struct({ kind: Schema.Literal("recipe"), ref: Schema.String }),
);

const RegistryEntrySchema = Schema.Struct({
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literal("none", "full"),
  detached: Schema.Boolean,
  ownerPid: Schema.optional(Schema.Number),
  rootPath: Schema.String,
  status: Schema.Literal("acquiring", "running", "stopping", "destroyed-pending-cleanup"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const RegistryEntriesSchema = Schema.Array(RegistryEntrySchema);

const RegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  entries: RegistryEntriesSchema,
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
    return Schema.decodeUnknownSync(RegistryEnvelopeSchema)(JSON.parse(content), {
      onExcessProperty: "error",
    }).entries;
  } catch {
    return null;
  }
};

const migrateLegacyEnvelope = (): Effect.Effect<void, ScratchAppError> => {
  const paths = scratchRegistryPaths();
  const inspectLegacyEnvelope = Effect.promise(async () => {
    try {
      return decodeLegacyEnvelope(await readFile(paths.registry, "utf8"));
    } catch (cause) {
      if (isMissing(cause)) return null;
      return null;
    }
  });

  const rewriteLegacyEnvelope = (entries: RegistryEntries) =>
    Schema.encode(RegistryEntriesSchema)(entries).pipe(
      Effect.map((encoded) => encodeFrame("json", REGISTRY_VERSION, encoded, entries)),
      Effect.flatMap((body) => writeFileAtomicScoped(paths.registry, body)),
      Effect.mapError((cause) =>
        scratchRegistryError("registry.migrate", "Unable to migrate the scratch registry.", cause),
      ),
    );

  return withAdvisoryLock(
    paths.registry,
    "registry.migrate",
    inspectLegacyEnvelope.pipe(
      Effect.flatMap((entries) => (entries === null ? Effect.void : rewriteLegacyEnvelope(entries))),
    ),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ScratchAppError
        ? cause
        : scratchRegistryError("registry.migrate", "Unable to migrate the scratch registry.", cause),
    ),
  );
};

/**
 * Re-acquire the legacy `registry.lock` advisory lock via the generic state
 * lock primitive. The scratch registry's mutations are now serialized by the
 * bucket's own advisory lock (`registry.bin.lock`); this helper is retained as a
 * thin delegation to the shared lock so callers that held the explicit lock
 * handle keep working with the same token-checked release semantics.
 */
export const acquireScratchRegistryLock = (
  paths: ScratchRegistryPaths = scratchRegistryPaths(),
): Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }, ScratchAppError> =>
  acquireAdvisoryLockAt(paths.lock, "registry.lock").pipe(
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

const openRegistryBucket = (): Effect.Effect<StateBucket<RegistryEntries>, ScratchAppError> =>
  makeStateStore()
    .open<RegistryEntries, RegistryEntries>({
      root: "userCache",
      namespace: "scratch",
      key: "registry.bin",
      schema: RegistryEntriesSchema,
      version: REGISTRY_VERSION,
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

export const makeScratchRegistry = (): ScratchRegistryService => {
  const withBucket = <A>(
    operation: string,
    message: string,
    use: (bucket: StateBucket<RegistryEntries>) => Effect.Effect<A, StateStoreError>,
  ): Effect.Effect<A, ScratchAppError> =>
    openRegistryBucket().pipe(
      Effect.flatMap((bucket) =>
        migrateLegacyEnvelope().pipe(
          Effect.zipRight(
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

export const ScratchRegistryLive = Layer.effect(
  ScratchRegistry,
  Effect.sync(() => makeScratchRegistry()),
);
