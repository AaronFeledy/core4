import { Context, Effect, Layer, Schema } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import type { StateStoreError } from "@lando/sdk/errors";
import { type StateBucket, StateStore } from "@lando/sdk/services";

// The scratch registry — a thin, scratch-shaped view over a single durable
// `StateBucket` under the user data root. All atomic write, advisory
// cross-process locking, corruption quarantine, and version-envelope handling
// are delegated to `StateStore`; this module only owns the scratch entry schema
// and the `read`/`upsert`/`remove`/`list`/`get` surface its callers expect. The
// live layer consumes the runtime's StateStore so configured roots and private-file
// access are shared with the rest of the runtime.

const REGISTRY_VERSION = 1 as const;

const ScratchSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fork") }),
  Schema.Struct({ kind: Schema.Literal("recipe"), ref: Schema.String }),
]);

const RegistryEntrySchema = Schema.Struct({
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literals(["full", "baked", "cwd"]),
  detached: Schema.Boolean,
  shareGlobalStorage: Schema.optionalKey(Schema.Boolean),
  ownerPid: Schema.optionalKey(Schema.Number),
  rootPath: Schema.String,
  status: Schema.Literals(["acquiring", "running", "stopping", "destroyed-pending-cleanup"]),
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

const scratchRegistryError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({
    operation,
    message,
    cause,
    remediation:
      typeof cause === "object" &&
      cause !== null &&
      "remediation" in cause &&
      typeof cause.remediation === "string"
        ? cause.remediation
        : "Repair the scratch registry state under the user data root, then retry.",
  });

const sortById = (entries: RegistryEntries): RegistryEntries =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

export interface ScratchRegistryService {
  readonly read: () => Effect.Effect<ScratchRegistryEnvelope, ScratchAppError>;
  readonly upsert: (entry: ScratchRegistryEntry) => Effect.Effect<void, ScratchAppError>;
  readonly remove: (id: string) => Effect.Effect<void, ScratchAppError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ScratchRegistryEntry>, ScratchAppError>;
  readonly get: (id: string) => Effect.Effect<ScratchRegistryEntry | undefined, ScratchAppError>;
}

export class ScratchRegistry extends Context.Service<ScratchRegistry, ScratchRegistryService>()(
  "@lando/engine/ScratchRegistry",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.map(StateStore, (store) => ScratchRegistry.of(makeScratchRegistry(store))),
  );
}

const openRegistryBucket = (
  store: StateStore["Service"],
): Effect.Effect<StateBucket<RegistryEntries>, ScratchAppError> =>
  store
    .open<RegistryEntries, RegistryEntries>({
      root: "userData",
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

export const makeScratchRegistry = (store: StateStore["Service"]): ScratchRegistryService => {
  const withBucket = <A>(
    operation: string,
    message: string,
    use: (bucket: StateBucket<RegistryEntries>) => Effect.Effect<A, StateStoreError>,
  ): Effect.Effect<A, ScratchAppError> =>
    openRegistryBucket(store).pipe(
      Effect.flatMap((bucket) =>
        use(bucket).pipe(Effect.mapError((cause) => scratchRegistryError(operation, message, cause))),
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
