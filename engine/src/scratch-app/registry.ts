import { mapFailures } from "@lando/sdk/command-result";
import type { StateStoreError } from "@lando/sdk/errors";

import { ScratchAppError } from "@lando/sdk/errors";
import { type StateBucket, StateStore, type StateWrite } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { Context, Effect, Layer, Schema } from "effect";

// The scratch registry — a thin, scratch-shaped view over a single durable
// `StateBucket` under the user data root. All atomic write, advisory
// cross-process locking, corruption quarantine, and version-envelope handling
// are delegated to `StateStore`; this module only owns the scratch entry schema
// and the `read`/`upsert`/`remove`/`list`/`get` surface its callers expect. The
// live layer consumes the runtime's StateStore so configured roots and private-file
// access are shared with the rest of the runtime.

export const SCRATCH_REGISTRY_VERSION = 3 as const;

export const ScratchRegistryLayout = Schema.Literals(["legacy", "managed"]);
export type ScratchRegistryLayout = typeof ScratchRegistryLayout.Type;

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
  layout: ScratchRegistryLayout,
  status: Schema.Literals(["acquiring", "running", "destroyed-pending-cleanup"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export const ScratchRegistryEntriesSchema = Schema.Array(RegistryEntrySchema);

const LegacyEntryFields = {
  id: Schema.String,
  source: ScratchSourceSchema,
  isolate: Schema.Literals(["full", "baked", "cwd"]),
  detached: Schema.Boolean,
  shareGlobalStorage: Schema.optionalKey(Schema.Boolean),
  ownerPid: Schema.optionalKey(Schema.Number),
  rootPath: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
};

const LegacyV1EntriesSchema = Schema.Array(
  Schema.Struct({
    ...LegacyEntryFields,
    status: Schema.Union([RegistryEntrySchema.fields.status, Schema.Literal("stopping")]),
  }),
);

const LegacyV2EntriesSchema = Schema.Array(
  Schema.Struct({
    ...LegacyEntryFields,
    status: RegistryEntrySchema.fields.status,
  }),
);

const withLegacyLayout = (
  entries: ReadonlyArray<{
    readonly id: string;
    readonly source: ScratchRegistryEntry["source"];
    readonly isolate: ScratchRegistryEntry["isolate"];
    readonly detached: boolean;
    readonly shareGlobalStorage?: boolean;
    readonly ownerPid?: number;
    readonly rootPath: string;
    readonly status: ScratchRegistryEntry["status"] | "stopping";
    readonly createdAt: string;
    readonly updatedAt: string;
  }>,
): ScratchRegistryEntry[] =>
  entries.map((entry) => {
    const status = entry.status;
    switch (status) {
      case "stopping":
        return { ...entry, status: "destroyed-pending-cleanup" as const, layout: "legacy" as const };
      case "acquiring":
      case "running":
      case "destroyed-pending-cleanup":
        return { ...entry, status, layout: "legacy" as const };
      default:
        return status satisfies never;
    }
  });

const RegistryEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(SCRATCH_REGISTRY_VERSION),
  entries: ScratchRegistryEntriesSchema,
});

export type ScratchRegistryEntry = typeof RegistryEntrySchema.Type;
export type ScratchRegistryEnvelope = typeof RegistryEnvelopeSchema.Type;

type RegistryEntries = ReadonlyArray<ScratchRegistryEntry>;

/** Each write names its step, and the step (not the caller) decides the stored status. */
export const scratchRegistryTransitions = defineTransitions<ScratchRegistryEntry["status"] | "absent">()({
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
/** Only acquisition accepts the initial detached policy; subsequent operations own it. */
export type ScratchRegistryWriteEntry = Omit<ScratchRegistryEntry, "status" | "detached">;
type ScratchRegistryWriteArgs =
  | [operation: "acquire", entry: ScratchRegistryWriteEntry & Pick<ScratchRegistryEntry, "detached">]
  | [operation: Exclude<ScratchRegistryWrite, "acquire">, entry: ScratchRegistryWriteEntry];
type ScratchRegistryMutation = ScratchRegistryWriteArgs | [operation: "remove", id: string];

const illegalWriteRemediation =
  "Run `lando apps:scratch:gc --prune` to clean up scratch apps left mid-destroy, then acquire a new scratch app.";

/**
 * Pure so the durable registry and its test doubles apply the same table. `Set`
 * stores the entry and `Remove` drops it; a settled step keeps the registry.
 */
export const planScratchRegistryWrite = (
  previous: ScratchRegistryEntry | undefined,
  ...[operation, entry]: ScratchRegistryMutation
): Effect.Effect<StateWrite<ScratchRegistryEntry, void>, ScratchAppError> => {
  const plan = planTransition(
    scratchRegistryTransitions,
    operation,
    previous?.status ?? "absent",
    (status): ScratchRegistryEntry | null => {
      if (operation === "remove" || status === "absent") return null;
      const detached =
        operation === "acquire" ? entry.detached : operation === "detach" || previous?.detached === true;
      return { ...entry, status, detached };
    },
  );
  switch (plan._tag) {
    case "Keep":
      return Effect.succeed({ _tag: "Keep", result: undefined });
    case "Write":
      return Effect.succeed(
        plan.value === null
          ? { _tag: "Remove", result: undefined }
          : { _tag: "Set", value: plan.value, result: undefined },
      );
    case "Illegal":
      return Effect.fail(
        new ScratchAppError({
          operation: "registry.write",
          message: illegalTransitionMessage(
            `Scratch app ${typeof entry === "string" ? entry : entry.id}`,
            operation,
            plan.verdict,
          ),
          remediation: illegalWriteRemediation,
        }),
      );
  }
};

const scratchRegistryError = (operation: string, message: string, cause: StateStoreError): ScratchAppError =>
  new ScratchAppError({
    operation,
    message,
    cause,
    remediation: cause.remediation,
  });

const sortById = (entries: RegistryEntries): RegistryEntries =>
  [...entries].sort((left, right) => left.id.localeCompare(right.id));

export interface ScratchRegistryService {
  readonly read: () => Effect.Effect<ScratchRegistryEnvelope, ScratchAppError>;
  readonly upsert: (...write: ScratchRegistryWriteArgs) => Effect.Effect<void, ScratchAppError>;
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
        if (fromVersion === 1) return withLegacyLayout(Schema.decodeUnknownSync(LegacyV1EntriesSchema)(raw));
        if (fromVersion === 2) return withLegacyLayout(Schema.decodeUnknownSync(LegacyV2EntriesSchema)(raw));
        Schema.decodeUnknownSync(Schema.Never)(fromVersion);
        return [];
      },
      default: [],
    })
    .pipe(
      mapFailures((cause) =>
        scratchRegistryError("registry.open", "Unable to open the scratch registry.", cause),
      ),
    );

export const makeScratchRegistry = (store: StateStore["Service"]): ScratchRegistryService => {
  const withBucket = <A>(
    operation: string,
    message: string,
    use: (bucket: StateBucket<RegistryEntries>) => Effect.Effect<A, ScratchAppError | StateStoreError>,
  ): Effect.Effect<A, ScratchAppError> =>
    openRegistryBucket(store).pipe(
      Effect.flatMap(use),
      mapFailures((cause) =>
        cause._tag === "StateStoreError" ? scratchRegistryError(operation, message, cause) : cause,
      ),
    );

  const list = () =>
    withBucket("registry.read", "Unable to read the scratch registry.", (bucket) =>
      bucket.get.pipe(Effect.map((entries) => entries ?? [])),
    );

  const read = () =>
    list().pipe(
      Effect.map(
        (entries) => ({ version: SCRATCH_REGISTRY_VERSION, entries }) satisfies ScratchRegistryEnvelope,
      ),
    );

  const get = (id: string) => list().pipe(Effect.map((entries) => entries.find((entry) => entry.id === id)));

  const write = (...mutation: ScratchRegistryMutation) => {
    const value = mutation[1];
    const id = typeof value === "string" ? value : value.id;
    return withBucket("registry.write", "Unable to write the scratch registry.", (bucket) =>
      bucket.mutate((current) => {
        const entries = current ?? [];
        return planScratchRegistryWrite(
          entries.find((existing) => existing.id === id),
          ...mutation,
        ).pipe(
          Effect.map((plan): StateWrite<RegistryEntries, void> => {
            const remaining = entries.filter((existing) => existing.id !== id);
            switch (plan._tag) {
              case "Keep":
                return plan;
              case "Remove":
                return { _tag: "Set", value: remaining, result: undefined };
              case "Set":
                return { _tag: "Set", value: sortById([...remaining, plan.value]), result: undefined };
              default: {
                const exhaustive: never = plan;
                return exhaustive;
              }
            }
          }),
        );
      }),
    );
  };

  return { read, upsert: write, remove: (id) => write("remove", id), list, get };
};
