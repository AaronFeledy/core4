import { createHash, randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";

import type { StateStoreShape } from "@lando/sdk/services";
import { CoreUpdateFailureSchema, UpdateNetworkError } from "./errors.ts";
import { PluginUpdatePlanRowSchema } from "./plugin-plan.ts";

const StoredUpdateResultSchema = Schema.Struct({
  coreFailure: Schema.optional(CoreUpdateFailureSchema),
  updatedCore: Schema.Boolean,
  updatedPlugins: Schema.Array(Schema.String),
  pluginResults: Schema.optional(Schema.Array(PluginUpdatePlanRowSchema)),
  hasFailures: Schema.optional(Schema.Boolean),
  coreBlocked: Schema.optional(Schema.Boolean),
  coreUpdateAvailable: Schema.optional(Schema.Boolean),
});

export type StoredUpdateResult = typeof StoredUpdateResultSchema.Type;

const UpdateHandoffReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planHash: Schema.String,
  completedRows: Schema.Array(PluginUpdatePlanRowSchema),
  result: StoredUpdateResultSchema,
  deferred: Schema.optional(Schema.Literal("pending", "complete")),
});

export interface UpdateHandoff {
  readonly token?: string;
  readonly save: (result: StoredUpdateResult) => Effect.Effect<string, UpdateNetworkError>;
  readonly consume: (token: string) => Effect.Effect<StoredUpdateResult | undefined, UpdateNetworkError>;
}

const handoffError = (operation: string, cause: unknown): UpdateNetworkError =>
  new UpdateNetworkError({
    message: `Failed to ${operation} the one-shot update replacement receipt.`,
    url: "state://update/handoff",
    cause,
  });

export const makeUpdateHandoff = (store: StateStoreShape, token?: string) => {
  const bucketFor = (opaqueToken: string) =>
    store.open({
      root: "userCache",
      namespace: "update-handoff",
      key: `${opaqueToken}.json`,
      schema: Schema.NullOr(UpdateHandoffReceiptSchema),
      version: 1,
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
    const planHash = createHash("sha256").update(JSON.stringify(completedRows)).digest("hex");
    return bucketFor(opaqueToken).pipe(
      Effect.flatMap((bucket) =>
        bucket
          .set({
            schemaVersion: 1,
            planHash,
            completedRows,
            result,
            ...(deferred === undefined ? {} : { deferred }),
          })
          .pipe(Effect.as(opaqueToken)),
      ),
      Effect.mapError((cause) => handoffError("persist", cause)),
    );
  };
  return {
    ...(token === undefined ? {} : { token }),
    save,
    saveDeferred: (result: StoredUpdateResult) => save(result, "pending"),
    finishDeferred: (opaqueToken: string, failure?: typeof CoreUpdateFailureSchema.Type) =>
      bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket.update((receipt) => {
            if (receipt === null) throw handoffError("finish", "Missing pending receipt");
            return {
              ...receipt,
              deferred: "complete" as const,
              result: {
                ...receipt.result,
                updatedCore: failure === undefined,
                ...(failure === undefined ? {} : { hasFailures: true, coreFailure: failure }),
              },
            };
          }),
        ),
        Effect.mapError((cause) => handoffError("finish", cause)),
      ),
    consumeDeferred: (opaqueToken: string) =>
      bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket.get.pipe(
            Effect.flatMap((current) =>
              current?.deferred !== "complete"
                ? Effect.succeed(undefined)
                : bucket
                    .modify((receipt) =>
                      receipt?.deferred === "complete" ? [receipt.result, null] : [undefined, receipt],
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
            .modify((receipt) => (receipt === null ? [undefined, null] : [receipt.result, null]))
            .pipe(Effect.tap(() => bucket.remove.pipe(Effect.catchAll(() => Effect.void)))),
        ),
        Effect.mapError((cause) => handoffError("consume", cause)),
      ),
  };
};
