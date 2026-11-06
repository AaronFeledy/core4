import { randomUUID } from "node:crypto";
import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import { UPDATE_HANDOFF_NAMESPACE } from "@lando/paths";
import type { StateStoreShape } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
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
const receiptTransitions = defineTransitions<"absent" | "one-shot" | "pending" | "complete">()({
  save: { from: ["absent"], to: "one-shot" },
  "save-deferred": { from: ["absent"], to: "pending" },
  "finish-deferred": { from: ["pending"], to: "complete" },
  "consume-deferred": { from: ["complete"], to: "absent" },
  consume: { from: ["one-shot"], to: "absent", settledIn: ["absent"] },
});

const receiptStep = (
  operation: keyof typeof receiptTransitions.edges,
  receipt: UpdateHandoffReceipt | null,
) => receiptTransitions.step(operation, receipt === null ? "absent" : (receipt.deferred ?? "one-shot"));

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
  const bucketFor = (opaqueToken: string) =>
    store.open({
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
    });
  const save = (result: StoredUpdateResult, deferred?: "pending") => {
    const opaqueToken = randomUUID();
    const completedRows = result.pluginResults ?? [];
    const planHash = sha256Hex(JSON.stringify(completedRows));
    const receipt: UpdateHandoffReceipt = {
      schemaVersion: 1,
      planHash,
      completedRows,
      result,
      ...(deferred === undefined ? {} : { deferred }),
    };
    return bucketFor(opaqueToken).pipe(
      Effect.flatMap((bucket) =>
        bucket.modify((current) =>
          receiptStep(deferred === undefined ? "save" : "save-deferred", current)._tag === "Advance"
            ? ([true, receipt] as const)
            : ([false, current] as const),
        ),
      ),
      Effect.mapError((cause) => handoffError("persist", cause)),
      Effect.flatMap((saved) =>
        saved
          ? Effect.succeed(opaqueToken)
          : Effect.fail(handoffError("persist", "Receipt token already in use")),
      ),
    );
  };
  return {
    ...(token === undefined ? {} : { token }),
    save,
    saveDeferred: (result: StoredUpdateResult) => save(result, "pending"),
    finishDeferred: (opaqueToken: string, failure?: typeof CoreUpdateFailureSchema.Type) =>
      bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket.modify((receipt) => {
            const verdict = receiptStep("finish-deferred", receipt);
            return receipt !== null && verdict._tag === "Advance"
              ? ([
                  verdict,
                  {
                    ...receipt,
                    deferred: "complete" as const,
                    result: {
                      ...receipt.result,
                      updatedCore: failure === undefined,
                      ...(failure === undefined ? {} : { hasFailures: true, coreFailure: failure }),
                    },
                  },
                ] as const)
              : ([verdict, receipt] as const);
          }),
        ),
        Effect.mapError((cause) => handoffError("finish", cause)),
        Effect.flatMap((verdict) =>
          verdict._tag === "Illegal"
            ? Effect.fail(
                handoffError(
                  "finish",
                  illegalTransitionMessage(`Update receipt ${opaqueToken}`, "finish-deferred", verdict),
                ),
              )
            : Effect.void,
        ),
      ),
    consumeDeferred: (opaqueToken: string) =>
      bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket.get.pipe(
            Effect.flatMap((current) =>
              receiptStep("consume-deferred", current)._tag !== "Advance"
                ? Effect.succeed(undefined)
                : bucket
                    .modify((receipt) =>
                      receipt !== null && receiptStep("consume-deferred", receipt)._tag === "Advance"
                        ? [receipt.result, null]
                        : [undefined, receipt],
                    )
                    .pipe(Effect.tap((receipt) => (receipt === undefined ? Effect.void : bucket.remove))),
            ),
          ),
        ),
        Effect.mapError((cause) => handoffError("consume", cause)),
      ),
    consume: (opaqueToken: string) =>
      bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket
            .modify((receipt) =>
              receiptStep("consume", receipt)._tag !== "Illegal"
                ? [{ result: receipt?.result, cleared: true }, null]
                : [{ result: undefined, cleared: false }, receipt],
            )
            .pipe(
              Effect.tap(({ cleared }) =>
                cleared ? bucket.remove.pipe(Effect.catch(() => Effect.void)) : Effect.void,
              ),
              Effect.map(({ result }) => result),
            ),
        ),
        Effect.mapError((cause) => handoffError("consume", cause)),
      ),
  };
};
