import { expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { type StateBucket, StateStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { readUpdateManifestState } from "../../src/update/manifest.ts";

const newerCause = new StateStoreError({
  reason: "newer-version",
  operation: "get",
  path: "/tmp/freshness.json",
  storedVersion: 99,
  supportedVersion: 2,
  remediation:
    "State at /tmp/freshness.json was written by a newer Lando (envelope version 99; this Lando supports 2). Run that newer Lando or upgrade. Leave the file in place.",
});

const failingStore = Layer.succeed(
  StateStore,
  StateStore.of({
    withLock: (_key, body) => body,
    open: () =>
      Effect.succeed({
        path: AbsolutePath.make("/tmp/freshness.json"),
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

test("manifest freshness maps newer-version store errors to upgrade remediation, not corrupt", async () => {
  const result = await Effect.runPromise(
    Effect.result(readUpdateManifestState("/tmp/freshness.json").pipe(Effect.provide(failingStore))),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "UpdateNetworkError",
      message: expect.stringContaining("written by a newer Lando"),
      remediation: newerCause.remediation,
    },
  });
  const failure = result._tag === "Failure" ? result.failure : undefined;
  expect(failure?.remediation.toLowerCase()).not.toContain("corrupt");
  expect(failure?.remediation.toLowerCase()).not.toContain("remove the");
});
