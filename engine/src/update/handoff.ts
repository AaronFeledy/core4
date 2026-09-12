import { createHash, randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";

import type { StateStoreShape } from "@lando/sdk/services";
import { UpdateNetworkError } from "./errors.ts";
import { PluginUpdatePlanRowSchema } from "./plugin-plan.ts";

const StoredUpdateResultSchema = Schema.Struct({
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

export const makeUpdateHandoff = (store: StateStoreShape, token?: string): UpdateHandoff => {
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
  return {
    ...(token === undefined ? {} : { token }),
    save: (result) => {
      const opaqueToken = randomUUID();
      const completedRows = result.pluginResults ?? [];
      const planHash = createHash("sha256").update(JSON.stringify(completedRows)).digest("hex");
      return bucketFor(opaqueToken).pipe(
        Effect.flatMap((bucket) =>
          bucket.set({ schemaVersion: 1, planHash, completedRows, result }).pipe(Effect.as(opaqueToken)),
        ),
        Effect.mapError((cause) => handoffError("persist", cause)),
      );
    },
    consume: (opaqueToken) =>
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
