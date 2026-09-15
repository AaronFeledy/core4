import { afterEach, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { AbsolutePath, AppId, type VolumeIdentity, type VolumeInfo } from "@lando/sdk/schema";

import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

test("adopts an observed legacy mount under its physical lock before an explicit snapshot", async () => {
  const harness = makeSqlTestDeps({ password: "test-password" });
  const configuredOwnerRoot = harness.deps.plan.identity?.appRoot;
  if (configuredOwnerRoot === undefined) throw new Error("fixture app identity missing");
  const ownerRoot = AbsolutePath.make(configuredOwnerRoot);
  let adopted = false;
  let adoptCalls = 0;
  let initializationIdentity: Parameters<typeof harness.deps.initialization>[0] | undefined;
  const adoptedIdentity: VolumeIdentity = {
    coordinationKey: "daemon:actual-legacy-data",
    nativeName: "actual-legacy-data",
    generation: "a1234567-1234-4123-8123-123456789abc",
    ownerRoot,
    origin: "adopted" as const,
  };
  const observed = (): VolumeInfo => ({
    ref: { app: AppId.make(harness.deps.plan.id), store: "actual-legacy-data" },
    provenance: "legacy" as const,
    ...(adopted ? { identity: adoptedIdentity } : {}),
  });
  const deps = {
    ...harness.deps,
    inspectVolume: () => Effect.succeed(observed()),
    locateVolume: () =>
      Effect.succeed({
        coordinationKey: adoptedIdentity.coordinationKey,
        nativeName: adoptedIdentity.nativeName,
      }),
    adoptVolume: () =>
      Effect.sync(() => {
        adoptCalls += 1;
        adopted = true;
        return observed();
      }),
    initialization: (identity: Parameters<typeof harness.deps.initialization>[0]) => {
      initializationIdentity = identity;
      return Effect.succeed({
        read: Effect.succeed(null),
        begin: () => Effect.succeed(false),
        finish: () => Effect.succeed(false),
      });
    },
  };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(adoptCalls).toBe(1);
  expect(initializationIdentity).toEqual(adoptedIdentity);
  expect(harness.lifecycle()).toEqual(["lock", "suspend", "snapshot", "resume"]);
  expect(harness.snapshots()[0]).toMatchObject({
    store: "actual-legacy-data",
    metadata: {
      sourceRoot: ownerRoot,
      volumeInstanceId: adoptedIdentity.generation,
    },
  });
});

test("adopts a legacy mount for recovery backup only after destructive confirmation", async () => {
  const harness = makeSqlTestDeps({ password: "test-password" });
  const configuredOwnerRoot = harness.deps.plan.identity?.appRoot;
  if (configuredOwnerRoot === undefined) throw new Error("fixture app identity missing");
  const ownerRoot = AbsolutePath.make(configuredOwnerRoot);
  let adopted = false;
  let adoptCalls = 0;
  const identity: VolumeIdentity = {
    coordinationKey: "daemon:legacy-reset-data",
    nativeName: "legacy-reset-data",
    generation: "b1234567-1234-4123-8123-123456789abc",
    ownerRoot,
    origin: "adopted" as const,
  };
  const observed = (): VolumeInfo => ({
    ref: { app: AppId.make(harness.deps.plan.id), store: identity.nativeName },
    provenance: "legacy" as const,
    ...(adopted ? { identity } : {}),
  });
  const deps = {
    ...harness.deps,
    inspectVolume: () => Effect.succeed(observed()),
    locateVolume: () =>
      Effect.succeed({ coordinationKey: identity.coordinationKey, nativeName: identity.nativeName }),
    adoptVolume: () =>
      Effect.sync(() => {
        adoptCalls += 1;
        adopted = true;
        return observed();
      }),
    initialization: () =>
      Effect.succeed({
        read: Effect.succeed(null),
        begin: () => Effect.succeed(false),
        finish: () => Effect.succeed(false),
      }),
  };

  const refused = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: false }));
  expect(Exit.isFailure(refused)).toBe(true);
  expect(adoptCalls).toBe(0);
  const confirmed = await Effect.runPromiseExit(executeDbCommand(deps, { action: "reset", yes: true }));

  expect(Exit.isSuccess(confirmed)).toBe(true);
  expect(adoptCalls).toBe(1);
  expect(harness.lifecycle()).toEqual(["lock", "suspend", "snapshot", "resume"]);
  expect(harness.snapshots()[0]?.metadata?.recoveryReason).toBe("reset");
});

test("refuses to adopt a legacy mount labeled for a foreign owner", async () => {
  const harness = makeSqlTestDeps({ password: "test-password" });
  let locateCalls = 0;
  let adoptCalls = 0;
  const deps = {
    ...harness.deps,
    inspectVolume: (): Effect.Effect<VolumeInfo> =>
      Effect.succeed({
        ref: { app: AppId.make(harness.deps.plan.id), store: "legacy-data" },
        provenance: "legacy",
        labels: { "dev.lando.volume-owner": "/foreign/app" },
      }),
    locateVolume: () =>
      Effect.sync(() => {
        locateCalls += 1;
        return { coordinationKey: "daemon:legacy-data", nativeName: "legacy-data" };
      }),
    adoptVolume: () =>
      Effect.sync(() => {
        adoptCalls += 1;
        return undefined;
      }),
  };

  const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

  expect(Exit.isFailure(exit)).toBe(true);
  expect(locateCalls).toBe(0);
  expect(adoptCalls).toBe(0);
  expect(harness.lifecycle()).toEqual([]);
  expect(harness.snapshots()).toEqual([]);
});

for (const conflict of ["witness", "native-name"] as const) {
  test(`refuses to adopt a legacy mount with a conflicting ${conflict}`, async () => {
    const harness = makeSqlTestDeps({ password: "test-password" });
    const configuredOwnerRoot = harness.deps.plan.identity?.appRoot;
    if (configuredOwnerRoot === undefined) throw new Error("fixture app identity missing");
    let adoptCalls = 0;
    const deps = {
      ...harness.deps,
      inspectVolume: (): Effect.Effect<VolumeInfo> =>
        Effect.succeed({
          ref: { app: AppId.make(harness.deps.plan.id), store: "legacy-data" },
          provenance: "legacy",
        }),
      locateVolume: () =>
        Effect.succeed({
          coordinationKey: "daemon:legacy-data",
          nativeName: conflict === "native-name" ? "different-volume" : "legacy-data",
          ...(conflict === "witness"
            ? {
                identity: {
                  coordinationKey: "daemon:legacy-data",
                  nativeName: "legacy-data",
                  generation: "c1234567-1234-4123-8123-123456789abc",
                  ownerRoot: AbsolutePath.make(configuredOwnerRoot),
                  origin: "created" as const,
                },
              }
            : {}),
        }),
      adoptVolume: () =>
        Effect.sync(() => {
          adoptCalls += 1;
          return undefined;
        }),
    };

    const exit = await Effect.runPromiseExit(executeDbCommand(deps, { action: "snapshot", yes: false }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(adoptCalls).toBe(0);
    expect(harness.lifecycle()).toEqual([]);
    expect(harness.snapshots()).toEqual([]);
  });
}
