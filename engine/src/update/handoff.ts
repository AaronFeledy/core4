import { randomUUID } from "node:crypto";
import { UPDATE_HANDOFF_NAMESPACE } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import type { StateStoreError } from "@lando/sdk/errors";
import type { StateBucket, StateStoreShape, StateWrite } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
import { Effect, Schema } from "effect";
import { CoreUpdateFailureSchema, UpdateNetworkError } from "./errors.ts";
import { PluginUpdatePlanRowSchema } from "./plugin-plan.ts";

const StoredUpdateResultSchema = Schema.Struct({
  coreFailure: Schema.optionalKey(CoreUpdateFailureSchema),
  updatedCore: Schema.Boolean,
  updatedPlugins: Schema.Array(Schema.String),
  pluginResults: Schema.optionalKey(Schema.Array(PluginUpdatePlanRowSchema)),
  hasFailures: Schema.optionalKey(Schema.Boolean),
  coreBlocked: Schema.optionalKey(Schema.Boolean),
  coreUpdateAvailable: Schema.optionalKey(Schema.Boolean),
});

export type StoredUpdateResult = typeof StoredUpdateResultSchema.Type;

export const UPDATE_HANDOFF_RECEIPT_VERSION = 1;

export const UpdateHandoffReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planHash: Schema.String,
  completedRows: Schema.Array(PluginUpdatePlanRowSchema),
  result: StoredUpdateResultSchema,
  deferred: Schema.optionalKey(Schema.Literals(["pending", "complete"])),
});

type UpdateHandoffReceipt = typeof UpdateHandoffReceiptSchema.Type;
/**
 * A POSIX replacement leaves a one-shot receipt for the re-executed binary. A Windows
 * replacement leaves a pending receipt that its helper finishes after the swap and the
 * next run consumes. A receipt in any other state is left untouched.
 */
export const receiptTransitions = defineTransitions<"absent" | "one-shot" | "pending" | "complete">()({
  save: { from: ["absent"], to: "one-shot" },
  "save-deferred": { from: ["absent"], to: "pending" },
  "finish-deferred": { from: ["pending"], to: "complete" },
  "consume-deferred": { from: ["complete"], to: "absent" },
  consume: { from: ["one-shot"], to: "absent", settledIn: ["absent"] },
});

const receiptState = (receipt: UpdateHandoffReceipt | null) =>
  receipt === null ? "absent" : (receipt.deferred ?? "one-shot");

export interface UpdateHandoff {
  readonly token?: string;
  readonly save: (result: StoredUpdateResult) => Effect.Effect<string, UpdateNetworkError>;
  readonly consume: (token: string) => Effect.Effect<StoredUpdateResult | undefined, UpdateNetworkError>;
}

const handoffError = (operation: string, cause: unknown): UpdateNetworkError =>
  new UpdateNetworkError({
    message: `Failed to ${operation} the one-shot update replacement receipt.`,
    url: "state://update/handoff",
    remediation: "Clear the update handoff receipt under the user data root and retry `lando update`.",
    cause,
  });

export const makeUpdateHandoff = (store: StateStoreShape, token?: string) => {
  const withReceipt = <A>(
    opaqueToken: string,
    action: "persist" | "finish" | "consume",
    use: (
      bucket: StateBucket<UpdateHandoffReceipt | null>,
    ) => Effect.Effect<A, UpdateNetworkError | StateStoreError>,
  ) =>
    store
      .open({
        root: "userData",
        namespace: UPDATE_HANDOFF_NAMESPACE,
        key: `${opaqueToken}.json`,
        schema: Schema.NullOr(UpdateHandoffReceiptSchema),
        version: UPDATE_HANDOFF_RECEIPT_VERSION,
        codec: "json",
        mode: 0o600,
        lock: "advisory",
        onCorrupt: "fail",
        onVersionMismatch: "discard",
        default: null,
      })
      .pipe(
        Effect.flatMap(use),
        Effect.catchTag("StateStoreError", (cause) => Effect.fail(handoffError(action, cause))),
      );
  const advance = (
    opaqueToken: string,
    operation: "save" | "save-deferred" | "finish-deferred",
    next: (receipt: UpdateHandoffReceipt | null) => UpdateHandoffReceipt | null,
  ) => {
    const action = operation === "finish-deferred" ? "finish" : "persist";
    return withReceipt(opaqueToken, action, (bucket) =>
      bucket.transition({
        transitions: receiptTransitions,
        operation,
        state: receiptState,
        next: (_to, receipt) => next(receipt),
        illegal: (verdict) =>
          handoffError(action, illegalTransitionMessage(`Update receipt ${opaqueToken}`, operation, verdict)),
      }),
    ).pipe(Effect.asVoid);
  };
  /** Removes an advancing receipt and returns its result; any other receipt is left untouched. */
  const take = (opaqueToken: string, operation: "consume" | "consume-deferred") =>
    withReceipt(opaqueToken, "consume", (bucket) =>
      bucket.mutate(
        (receipt): Effect.Effect<StateWrite<UpdateHandoffReceipt | null, StoredUpdateResult | undefined>> =>
          Effect.succeed(
            receiptTransitions.step(operation, receiptState(receipt))._tag === "Advance"
              ? { _tag: "Remove", result: receipt?.result }
              : { _tag: "Keep", result: undefined },
          ),
      ),
    );
  const save = (result: StoredUpdateResult, deferred?: "pending") => {
    const opaqueToken = randomUUID();
    const completedRows = result.pluginResults ?? [];
    const receipt: UpdateHandoffReceipt = {
      schemaVersion: 1,
      planHash: sha256Hex(JSON.stringify(completedRows)),
      completedRows,
      result,
      ...(deferred === undefined ? {} : { deferred }),
    };
    return advance(opaqueToken, deferred === undefined ? "save" : "save-deferred", () => receipt).pipe(
      Effect.as(opaqueToken),
    );
  };
  return {
    ...(token === undefined ? {} : { token }),
    save,
    saveDeferred: (result: StoredUpdateResult) => save(result, "pending"),
    finishDeferred: (opaqueToken: string, failure?: typeof CoreUpdateFailureSchema.Type) =>
      // Only a stored pending receipt advances, so `receipt` is never null here.
      advance(opaqueToken, "finish-deferred", (receipt) =>
        receipt === null
          ? null
          : {
              ...receipt,
              deferred: "complete",
              result: {
                ...receipt.result,
                updatedCore: failure === undefined,
                ...(failure === undefined ? {} : { hasFailures: true, coreFailure: failure }),
              },
            },
      ),
    consumeDeferred: (opaqueToken: string) => take(opaqueToken, "consume-deferred"),
    consume: (opaqueToken: string) => take(opaqueToken, "consume"),
  };
};
