import { Context, Effect, Layer, Schema } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import type { StateStoreError } from "@lando/sdk/errors";
import { type StateBucket, StateStore } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";

// The scratch registry — a thin, scratch-shaped view over a single durable
// `StateBucket` under the user data root. All atomic write, advisory
// cross-process locking, corruption quarantine, and version-envelope handling
// are delegated to `StateStore`; this module only owns the scratch entry schema
// and the `read`/`upsert`/`remove`/`list`/`get` surface its callers expect. The
// live layer consumes the runtime's StateStore so configured roots and private-file
// access are shared with the rest of the runtime.

export const SCRATCH_REGISTRY_VERSION = 2 as const;

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
  status: Schema.Literals(["acquiring", "running", "destroyed-pending-cleanup"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const ScratchRegistryEntriesSchema = Schema.Array(RegistryEntrySchema);

const LegacyRegistryEntriesSchema = Schema.Array(
  Schema.Struct({
    ...RegistryEntrySchema.fields,
    status: Schema.Union([RegistryEntrySchema.fields.status, Schema.Literal("stopping")]),
  }),
);

const RegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(SCRATCH_REGISTRY_VERSION),
  entries: ScratchRegistryEntriesSchema,
});

export type ScratchRegistryEntry = typeof RegistryEntrySchema.Type;
export type ScratchRegistryEnvelope = typeof RegistryEnvelopeSchema.Type;

type RegistryEntries = ReadonlyArray<ScratchRegistryEntry>;

/** Each write names its step, and the step (not the caller) decides the stored status. */
const scratchRegistryTransitions = defineTransitions<ScratchRegistryEntry["status"] | "absent">()({
  acquire: { from: ["absent"], to: "acquiring" },
  "mark-running": { from: ["acquiring"], to: "running" },
  detach: { from: ["acquiring", "running"] },
  "mark-pending-cleanup": {
    from: ["acquiring", "running", "destroyed-pending-cleanup"],
    to: "destroyed-pending-cleanup",
  },
  remove: {
    from: ["acquiring", "running", "destroyed-pending-cleanup"],
    to: "absent",
    settledIn: ["absent"],
  },
});

type ScratchRegistryOperation = keyof typeof scratchRegistryTransitions.edges;
export type ScratchRegistryWrite = Exclude<ScratchRegistryOperation, "remove">;
/** Writers supply every field but the status, which their operation determines. */
export type ScratchRegistryWriteEntry = Omit<ScratchRegistryEntry, "status">;

export type ScratchRegistryWritePlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Store"; readonly entry: ScratchRegistryEntry }
  | { readonly _tag: "Delete" }
  | { readonly _tag: "Reject"; readonly message: string };

/** Pure so the durable registry and its test doubles apply the same table. */
export const planScratchRegistryWrite = (
  operation: ScratchRegistryOperation,
  id: string,
  previous: ScratchRegistryEntry | undefined,
  entry?: ScratchRegistryWriteEntry,
): ScratchRegistryWritePlan => {
  const verdict = scratchRegistryTransitions.step(operation, previous?.status ?? "absent");
  switch (verdict._tag) {
    case "Settled":
      return { _tag: "Unchanged" };
    case "Illegal":
      return { _tag: "Reject", message: illegalTransitionMessage(`Scratch app ${id}`, operation, verdict) };
    case "Advance": {
      const status = verdict.to;
      return status === "absent" || entry === undefined
        ? { _tag: "Delete" }
        : { _tag: "Store", entry: { ...entry, status } };
    }
  }
};

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
  readonly upsert: (
    operation: ScratchRegistryWrite,
    entry: ScratchRegistryWriteEntry,
  ) => Effect.Effect<void, ScratchAppError>;
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
      schema: ScratchRegistryEntriesSchema,
      version: SCRATCH_REGISTRY_VERSION,
      mode: 0o600,
      codec: "json",
      lock: "advisory",
      onCorrupt: "quarantine",
      onVersionMismatch: (raw, fromVersion) => {
        Schema.decodeUnknownSync(Schema.Literal(1))(fromVersion);
        return Schema.decodeUnknownSync(LegacyRegistryEntriesSchema)(raw).map((entry) => {
          const status = entry.status;
          switch (status) {
            case "stopping":
              return { ...entry, status: "destroyed-pending-cleanup" as const };
            case "acquiring":
            case "running":
            case "destroyed-pending-cleanup":
              return { ...entry, status };
            default:
              return status satisfies never;
          }
        });
      },
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
      Effect.map(
        (entries) => ({ version: SCRATCH_REGISTRY_VERSION, entries }) satisfies ScratchRegistryEnvelope,
      ),
    );

  const list = () => readEntries("registry.read", "Unable to read the scratch registry.");

  const get = (id: string) => list().pipe(Effect.map((entries) => entries.find((entry) => entry.id === id)));

  const write = (operation: ScratchRegistryOperation, id: string, entry?: ScratchRegistryWriteEntry) =>
    withBucket("registry.write", "Unable to write the scratch registry.", (bucket) =>
      bucket.modify((current): readonly [ScratchAppError | undefined, RegistryEntries] => {
        const entries = current ?? [];
        const plan = planScratchRegistryWrite(
          operation,
          id,
          entries.find((existing) => existing.id === id),
          entry,
        );
        const remaining = entries.filter((existing) => existing.id !== id);
        switch (plan._tag) {
          case "Unchanged":
            return [undefined, entries];
          case "Delete":
            return [undefined, remaining];
          case "Store":
            return [undefined, sortById([...remaining, plan.entry])];
          case "Reject":
            return [
              scratchRegistryError("registry.write", plan.message, {
                remediation:
                  "Run `lando apps:scratch:gc --prune` to clean up scratch apps left mid-destroy, then acquire a new scratch app.",
              }),
              entries,
            ];
        }
      }),
    ).pipe(Effect.flatMap((error) => (error === undefined ? Effect.void : Effect.fail(error))));

  const upsert = (operation: ScratchRegistryWrite, entry: ScratchRegistryWriteEntry) =>
    write(operation, entry.id, entry);

  const remove = (id: string) => write("remove", id);

  return { read, upsert, remove, list, get };
};
