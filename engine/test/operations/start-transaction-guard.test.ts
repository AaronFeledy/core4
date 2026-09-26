import { expect, test } from "bun:test";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Either } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("fails start before events or provider action when the transaction is blocked", async () => {
  // Given
  const roots: string[] = [];
  const providerActions: string[] = [];
  const harness = makeHarness({
    onApply: () => providerActions.push("apply"),
    onDestroy: () => providerActions.push("destroy"),
  });
  const failure = new ManagedFileTransactionError({
    reason: "blocked",
    phase: "recover",
    path: String(plan.root),
    cause: "invariant",
    remediation: "Resolve the conflicting target before starting.",
  });

  // When
  const result = await Effect.runPromise(
    startAppForTarget(undefined, {
      plan,
      root: plan.root,
      app: { kind: "user", id: plan.id, root: plan.root },
    }).pipe(
      Effect.provideService(ManagedFileTransactionGuard, {
        ensureConsistent: (root) => {
          roots.push(root);
          return Effect.fail(failure);
        },
        pending: () => Effect.succeed(null),
      }),
      Effect.provide(harness.layer),
      Effect.either,
    ),
  );

  // Then
  expect(Either.isLeft(result) && result.left).toBe(failure);
  expect(roots).toEqual([String(plan.root)]);
  expect(providerActions).toEqual([]);
  expect(harness.events).toEqual([]);
});

for (const [name, operation] of [
  ["start", startAppForTarget],
  ["restart", restartApp],
  ["rebuild", rebuildApp],
] as const) {
  test(`${name} rejects unsafe sync before transaction recovery touches app files`, async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "unknown",
      onDestroy: () => calls.push("destroy"),
      onApply: () => calls.push("apply"),
      onPublish: (event) => {
        if (event._tag === "pre-init") calls.push("init");
        return Effect.void;
      },
    });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
    const guard = {
      ensureConsistent: () =>
        Effect.sync(() => {
          calls.push("recover");
        }),
      pending: () => Effect.succeed(null),
    };
    const result = await Effect.runPromise(
      operation({}, target).pipe(
        Effect.provideService(ManagedFileTransactionGuard, guard),
        Effect.provide(harness.layer),
        Effect.either,
      ),
    );
    expect(Either.isLeft(result)).toBe(true);
    expect(calls).toEqual([]);
    expect(harness.events).toEqual([]);
  });
}

for (const name of ["start", "restart", "rebuild"] as const) {
  test(`${name} checks a blocked transaction once before init or provider action`, async () => {
    const calls: string[] = [];
    const failure = new ManagedFileTransactionError({
      reason: "blocked",
      phase: "recover",
      path: String(plan.root),
      cause: "invariant",
      remediation: "Resolve the conflicting target before starting.",
    });
    const harness = makeHarness({
      onApply: () => calls.push("apply"),
      onDestroy: () => calls.push("destroy"),
      onPublish: (event) => {
        if (event._tag === "pre-init") calls.push("init");
        return Effect.void;
      },
    });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
    const guard = {
      ensureConsistent: (root: string) => {
        calls.push(`guard:${root}`);
        return Effect.fail(failure);
      },
      pending: () => Effect.succeed(null),
    };
    const result =
      name === "start"
        ? await Effect.runPromise(
            startAppForTarget({}, target).pipe(
              Effect.provideService(ManagedFileTransactionGuard, guard),
              Effect.provide(harness.layer),
              Effect.either,
            ),
          )
        : name === "restart"
          ? await Effect.runPromise(
              restartApp({}, target).pipe(
                Effect.provideService(ManagedFileTransactionGuard, guard),
                Effect.provide(harness.layer),
                Effect.either,
              ),
            )
          : await Effect.runPromise(
              rebuildApp({}, target).pipe(
                Effect.provideService(ManagedFileTransactionGuard, guard),
                Effect.provide(harness.layer),
                Effect.either,
              ),
            );
    expect(Either.isLeft(result) && result.left).toBe(failure);
    expect(calls).toEqual([`guard:${plan.root}`]);
    expect(harness.events).toEqual([]);
  });

  test(`${name} checks the transaction once before init and provider work`, async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      onApply: () => calls.push("apply"),
      onDestroy: () => calls.push("destroy"),
      onPublish: (event) => {
        if (event._tag === "pre-init") calls.push("init");
        return Effect.void;
      },
    });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
    const guard = {
      ensureConsistent: (root: string) =>
        Effect.sync(() => {
          calls.push(`guard:${root}`);
        }),
      pending: () => Effect.succeed(null),
    };
    if (name === "start") {
      await Effect.runPromise(
        startAppForTarget({}, target).pipe(
          Effect.provideService(ManagedFileTransactionGuard, guard),
          Effect.provide(harness.layer),
        ),
      );
    } else if (name === "restart") {
      await Effect.runPromise(
        restartApp({}, target).pipe(
          Effect.provideService(ManagedFileTransactionGuard, guard),
          Effect.provide(harness.layer),
        ),
      );
    } else {
      await Effect.runPromise(
        rebuildApp({}, target).pipe(
          Effect.provideService(ManagedFileTransactionGuard, guard),
          Effect.provide(harness.layer),
        ),
      );
    }
    expect(calls[0]).toBe(`guard:${plan.root}`);
    expect(calls.filter((call) => call.startsWith("guard:"))).toHaveLength(1);
    expect(calls.filter((call) => call === "init")).toHaveLength(1);
    expect(calls.filter((call) => call === "apply")).toHaveLength(1);
    expect(calls.filter((call) => call === "destroy")).toHaveLength(name === "start" ? 0 : 1);
    expect(calls.indexOf("init")).toBeLessThan(calls.indexOf("apply"));
    if (name !== "start") expect(calls.indexOf("init")).toBeLessThan(calls.indexOf("destroy"));
  });
}
