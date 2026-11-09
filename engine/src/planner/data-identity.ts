import { mapFailures } from "@lando/sdk/command-result";
import { AppDataIdentityError } from "@lando/sdk/errors";
import type { AppIdentity } from "@lando/sdk/schema";
import { type LandoRoots, StateStore } from "@lando/sdk/services";
import { defineTransitions } from "@lando/sdk/transitions";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect, Option, Schema } from "effect";

export const AppDataIdentityRecord = Schema.Struct({ name: Schema.String });
export const appDataIdentityTransitions = defineTransitions<"absent" | "present">()({
  record: { from: ["absent"], to: "present", settledIn: ["present"] },
  clear: { from: ["present"], to: "absent", settledIn: ["absent"] },
});

export const appDataIdentityBucketSpec = (identity: AppIdentity) => ({
  root: "userData" as const,
  namespace: "app-data-identity",
  key: `${identity.ownerKey}.json`,
  schema: AppDataIdentityRecord,
  version: 1,
  codec: "json" as const,
  lock: "advisory" as const,
  onCorrupt: "fail" as const,
});

const identityFailure = (identity: AppIdentity, cause?: unknown) =>
  new AppDataIdentityError({
    appRoot: identity.appRoot,
    ...(cause === undefined ? {} : { cause }),
    message: "The folder's data identity could not be read or updated safely.",
    remediation:
      "Restore the app-data-identity record from a backup or correct its permissions, then retry. Do not remove it while the folder still owns data volumes.",
  });

export const readAppDataIdentity = Effect.fn("AppDataIdentity.read")(function* (
  identity: AppIdentity,
  roots?: LandoRoots,
) {
  const provided = yield* Effect.serviceOption(StateStore);
  const store = Option.isSome(provided)
    ? provided.value
    : yield* StateStore.pipe(
        Effect.provide(roots === undefined ? DiskStateStore.layer : DiskStateStore.layerAt(roots)),
      );
  return yield* store.open(appDataIdentityBucketSpec(identity)).pipe(
    Effect.flatMap((bucket) => bucket.get),
    mapFailures((cause) => identityFailure(identity, cause)),
  );
});

const transitionAppDataIdentity = (
  identity: AppIdentity,
  operation: "record" | "clear",
  next: typeof AppDataIdentityRecord.Type | null,
) =>
  Effect.flatMap(StateStore, (store) => store.open(appDataIdentityBucketSpec(identity))).pipe(
    Effect.flatMap((bucket) =>
      bucket.transition({
        transitions: appDataIdentityTransitions,
        operation,
        state: (current) => (current === null ? "absent" : "present"),
        next: () => next,
        illegal: () => identityFailure(identity),
      }),
    ),
    mapFailures((cause) => identityFailure(identity, cause)),
  );

export const recordAppDataIdentity = Effect.fn("AppDataIdentity.record")(function* (
  identity: AppIdentity,
  name: string,
) {
  yield* transitionAppDataIdentity(identity, "record", { name });
});

export const clearAppDataIdentity = Effect.fn("AppDataIdentity.clear")(function* (identity: AppIdentity) {
  yield* transitionAppDataIdentity(identity, "clear", null);
});
