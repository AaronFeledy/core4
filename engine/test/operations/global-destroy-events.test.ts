import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { globalDestroy } from "../../src/operations/global-destroy.ts";
import { globalStop } from "../../src/operations/global-stop.ts";
import { globalPlanAt, globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { ownedGlobalOrphan } from "./owned-global-orphan.ts";

const withRoot = async (use: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "global-destroy-events-")));
  try {
    await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  { volumes: false, purge: false, effective: false },
  { volumes: true, purge: false, effective: true },
  { volumes: false, purge: true, effective: true },
])("global destroy brackets progress and routes with options %j", async (options) => {
  await withRoot(async (root) => {
    // Given an applied global app and observable provider, router and event ports.
    const plan = globalPlanAt(AbsolutePath.make(join(root, "global")));
    const harness = await globalTeardownHarness(root, { plan });
    // When the destroy command runs.
    await Effect.runPromise(globalDestroy(options).pipe(Effect.provide(harness.layer)));
    // Then the bracket covers all destructive work, and requested purge stays distinct from effective volumes.
    expect(harness.calls.filter((call) => !call.startsWith("task."))).toEqual([
      "pre-global-destroy",
      "bringDown",
      "removeRoutes",
      "post-global-destroy",
    ]);
    expect(harness.calls.indexOf("pre-global-destroy")).toBeLessThan(
      harness.calls.indexOf("task.tree.start"),
    );
    expect(harness.calls.indexOf("task.tree.start")).toBeLessThan(harness.calls.indexOf("bringDown"));
    expect(harness.calls.indexOf("removeRoutes")).toBeLessThan(harness.calls.indexOf("task.tree.complete"));
    expect(harness.calls.at(-1)).toBe("post-global-destroy");
    expect(harness.destroyOptions).toEqual([
      { containers: "remove", volumes: options.effective, removeState: true },
    ]);
    expect(harness.events[0]).toMatchObject({
      _tag: "pre-global-destroy",
      scope: "global",
      app: { kind: "global", id: "global", root: plan.root },
      evidence: "applied",
      volumes: options.effective,
      purge: options.purge,
    });
    expect(harness.events.at(-1)).toMatchObject({
      _tag: "post-global-destroy",
      outcome: "destroyed",
      volumes: options.effective,
      purge: options.purge,
    });
  });
});

test("global stop emits no destroy bracket or destroy progress", async () => {
  await withRoot(async (root) => {
    // Given applied global state.
    const harness = await globalTeardownHarness(root, {
      plan: globalPlanAt(AbsolutePath.make(join(root, "global"))),
    });
    // When stop uses the shared teardown implementation.
    await Effect.runPromise(globalStop().pipe(Effect.provide(harness.layer)));
    // Then only the stop bracket surrounds provider and route cleanup.
    expect(harness.calls).toEqual(["pre-global-stop", "bringDown", "removeRoutes", "post-global-stop"]);
  });
});

test("absent global destroy emits no lifecycle or task events", async () => {
  await withRoot(async (root) => {
    // Given no applied or observed resources.
    const harness = await globalTeardownHarness(root);
    // When destroy is requested.
    const result = await Effect.runPromise(globalDestroy({}).pipe(Effect.provide(harness.layer)));
    // Then historical routes are withdrawn without inventing container lifecycle events.
    expect(result.outcome).toBe("unchanged");
    expect(harness.events).toEqual([]);
    expect(harness.calls).toContain("removeRoutes");
    expect(harness.calls).not.toContain("bringDown");
    expect(harness.calls).not.toContain("ensureReady");
  });
});

test.each(["provider", "routes"] as const)("global %s failure suppresses post-destroy", async (failure) => {
  await withRoot(async (root) => {
    // Given a failure after the destroy bracket opens.
    const appRoot = AbsolutePath.make(join(root, "global"));
    const harness = await globalTeardownHarness(
      root,
      failure === "provider"
        ? { services: [ownedGlobalOrphan(appRoot, root)], stopFailure: true }
        : { plan: globalPlanAt(appRoot), routeFailure: true },
    );
    // When teardown fails.
    const result = await Effect.runPromise(
      globalDestroy({}).pipe(Effect.provide(harness.layer), Effect.result),
    );
    // Then progress closes unsuccessfully without reporting successful destroy.
    expect(result._tag).toBe("Failure");
    expect(harness.calls).toContain("pre-global-destroy");
    expect(harness.calls).toContain("task.tree.complete");
    expect(harness.calls).not.toContain("post-global-destroy");
  });
});

test("provider no-op reports unchanged in the completed global destroy event", async () => {
  await withRoot(async (root) => {
    // Given applied evidence whose provider reports no mutation.
    const harness = await globalTeardownHarness(root, {
      plan: globalPlanAt(AbsolutePath.make(join(root, "global"))),
      destroyOutcome: { kind: "no-op", reason: "no-applied-plan" },
    });
    // When destroy completes route cleanup.
    const result = await Effect.runPromise(globalDestroy({}).pipe(Effect.provide(harness.layer)));
    // Then the result and closing event agree about actual mutation.
    expect(result.outcome).toBe("unchanged");
    expect(harness.events.at(-1)).toMatchObject({ _tag: "post-global-destroy", outcome: "unchanged" });
  });
});
