import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { StateWrite } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { Effect, Schema } from "effect";

const identity = {
  specDigest: Schema.String,
  volumeNonce: Schema.String,
  helperNonce: Schema.String,
};
export const WindowsSyncHelperReceipt = Schema.Union([
  Schema.Struct({
    ...identity,
    phase: Schema.Literal("claimed"),
    volumeCreatedAt: Schema.Null,
    containerId: Schema.Null,
  }),
  Schema.Struct({
    ...identity,
    phase: Schema.Literal("volume-created"),
    volumeCreatedAt: Schema.NonEmptyString,
    containerId: Schema.Null,
  }),
  Schema.Struct({
    ...identity,
    phase: Schema.Literal("helper-created"),
    volumeCreatedAt: Schema.NonEmptyString,
    containerId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...identity,
    phase: Schema.Literal("removing"),
    volumeCreatedAt: Schema.NonEmptyString,
    containerId: Schema.NullOr(Schema.NonEmptyString),
  }),
]);
export type Receipt = typeof WindowsSyncHelperReceipt.Type;
export const WINDOWS_SYNC_HELPER_RECEIPT_VERSION = 2;

const legacyReceipt = Schema.Struct({
  ...identity,
  volumeCreatedAt: Schema.NullOr(Schema.String),
  containerId: Schema.NullOr(Schema.String),
  removing: Schema.optionalKey(Schema.Boolean),
});

export const receiptFailure = (message: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "syncHelper.receipt",
    message,
    remediation:
      "Inspect the named volume and sync helper in the managed Podman machine, then retry with resources owned by this app.",
    cause,
  });

const migrateReceipt = (raw: unknown, fromVersion: number): Receipt => {
  if (fromVersion !== 1) throw receiptFailure("The sync helper ownership receipt has an unknown version.");
  const old = Schema.decodeUnknownSync(legacyReceipt)(raw);
  const phase =
    old.removing === true
      ? "removing"
      : old.containerId !== null
        ? "helper-created"
        : old.volumeCreatedAt !== null
          ? "volume-created"
          : "claimed";
  // Decode the original fingerprints together; never invent a missing ownership proof.
  return Schema.decodeUnknownSync(WindowsSyncHelperReceipt)({ ...old, phase });
};

// Operations that record a new proof are never settled: a repeat carries a fresh
// value, and keeping the stored one would hide which resource the caller created.
export const transitions = defineTransitions<Receipt["phase"] | "absent">()({
  claim: { from: ["absent"], to: "claimed" },
  "record-volume": { from: ["claimed"], to: "volume-created" },
  "record-helper": { from: ["volume-created"], to: "helper-created" },
  "begin-removal": { from: ["volume-created", "helper-created"], to: "removing", settledIn: ["removing"] },
  "reset-helper": { from: ["removing"], to: "volume-created" },
  forget: { from: ["claimed", "removing"], to: "absent", settledIn: ["absent"] },
});

type ReceiptOperation =
  | {
      readonly operation: "claim";
      readonly specDigest: string;
      readonly volumeNonce: string;
      readonly helperNonce: string;
    }
  | { readonly operation: "record-volume"; readonly volumeCreatedAt: string }
  | { readonly operation: "record-helper"; readonly containerId: string }
  | { readonly operation: "begin-removal" }
  | { readonly operation: "reset-helper"; readonly helperNonce: string }
  | { readonly operation: "forget" };

export const openReceipt = (stateStore: PluginStateStore, key: string) =>
  stateStore.open({
    namespace: "windows-sync-helpers",
    key,
    schema: WindowsSyncHelperReceipt,
    version: WINDOWS_SYNC_HELPER_RECEIPT_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: migrateReceipt,
  });

export const stateFailure = (cause: unknown): ProviderUnavailableError => {
  if (cause instanceof ProviderUnavailableError) return cause;
  if (cause instanceof StateStoreError && cause.cause instanceof ProviderUnavailableError) return cause.cause;
  return receiptFailure("Unable to read or update the sync helper ownership receipt.", cause);
};

const proposedReceipt = (change: ReceiptOperation, current: Receipt | null) => {
  switch (change.operation) {
    case "claim":
      return { ...change, volumeCreatedAt: null, containerId: null };
    case "record-volume":
      return { ...current, volumeCreatedAt: change.volumeCreatedAt };
    case "record-helper":
      return { ...current, containerId: change.containerId };
    case "begin-removal":
      return current;
    case "reset-helper":
      return { ...current, containerId: null, helperNonce: change.helperNonce };
    case "forget":
      return null;
    default:
      return change satisfies never;
  }
};

/** The caller holds withReceiptLock across resource actions and these atomic writes. */
export function changeReceipt(
  stateStore: PluginStateStore,
  key: string,
  change: Exclude<ReceiptOperation, { readonly operation: "forget" }>,
): Effect.Effect<Receipt, ProviderUnavailableError>;
export function changeReceipt(
  stateStore: PluginStateStore,
  key: string,
  change: { readonly operation: "forget" },
): Effect.Effect<null, ProviderUnavailableError>;
export function changeReceipt(
  stateStore: PluginStateStore,
  key: string,
  change: ReceiptOperation,
): Effect.Effect<Receipt | null, ProviderUnavailableError> {
  return openReceipt(stateStore, key).pipe(
    Effect.flatMap((bucket) =>
      bucket.mutate(
        (current): Effect.Effect<StateWrite<Receipt, Receipt | null>, ProviderUnavailableError> => {
          const plan = planTransition(transitions, change.operation, current?.phase ?? "absent", (to) => {
            const fields = proposedReceipt(change, current);
            return fields === null ? null : { ...fields, phase: to };
          });
          switch (plan._tag) {
            case "Illegal":
              return Effect.fail(
                receiptFailure(
                  illegalTransitionMessage("Sync helper receipt", change.operation, plan.verdict),
                ),
              );
            case "Keep":
              return Effect.succeed({ _tag: "Keep", result: current });
            case "Write":
              // The table picks the phase; decoding proves the fields match it before the write.
              return plan.value === null
                ? Effect.succeed({ _tag: "Remove", result: null })
                : Schema.decodeUnknownEffect(WindowsSyncHelperReceipt)(plan.value).pipe(
                    mapFailures(stateFailure),
                    Effect.map((value) => ({ _tag: "Set", value, result: value }) as const),
                  );
            default:
              return plan satisfies never;
          }
        },
      ),
    ),
    mapFailures(stateFailure),
  );
}
