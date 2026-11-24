import { expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { type StateBucket, StateStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { readAppDataIdentity } from "../../src/planner/data-identity.ts";

const identity = {
  appRoot: AbsolutePath.make("/apps/demo"),
  ownerKey: "owner-demo",
};

const newerCause = new StateStoreError({
  reason: "newer-version",
  operation: "get",
  path: "/data/app-data-identity/owner-demo.json",
  storedVersion: 2,
  supportedVersion: 1,
  remediation:
    "State at /data/app-data-identity/owner-demo.json was written by a newer Lando (envelope version 2; this Lando supports 1). Run that newer Lando or upgrade. Leave the file in place.",
});

const failingStore = Layer.succeed(
  StateStore,
  StateStore.of({
    withLock: (_key, body) => body,
    open: () =>
      Effect.succeed({
        path: AbsolutePath.make("/data/app-data-identity/owner-demo.json"),
        get: Effect.fail(newerCause),
        set: () => Effect.fail(newerCause),
        update: () => Effect.fail(newerCause),
        modify: () => Effect.fail(newerCause),
        mutate: () => Effect.fail(newerCause),
        transition: () => Effect.fail(newerCause),
        remove: Effect.fail(newerCause),
        exists: Effect.succeed(true),
      } satisfies StateBucket<unknown>),
  }),
);

test("app data identity keeps newer-version upgrade remediation", async () => {
  const result = await Effect.runPromise(
    Effect.result(readAppDataIdentity(identity).pipe(Effect.provide(failingStore))),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "AppDataIdentityError",
      remediation: newerCause.remediation,
      cause: newerCause,
    },
  });
  const failure = result._tag === "Failure" ? result.failure : undefined;
  expect(failure?.remediation.toLowerCase()).not.toContain("restore the app-data-identity");
});
