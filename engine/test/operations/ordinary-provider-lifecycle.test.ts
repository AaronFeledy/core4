import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";

import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const app = { kind: "user" as const, id: plan.id, root: plan.root };
const planned: AppPlan = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      appMount: {
        source: plan.root,
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "accelerated",
        excludes: [],
        includes: [],
      },
    },
  },
  fileSync: [
    {
      engineId: "mutagen",
      session: {
        app,
        service: web.name,
        mountKey: "app-mount",
        source: plan.root,
        target: { _tag: "volume", name: "test-start-web-app-mount", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
};
const target = { plan: planned, root: planned.root, app };
type LifecycleOperation = ReturnType<
  typeof stopAppForTarget | typeof destroyAppForTarget | typeof restartApp | typeof rebuildApp
>;
const operations: ReadonlyArray<{
  readonly name: string;
  readonly run: Effect.Effect<
    void,
    Effect.Effect.Error<LifecycleOperation>,
    Effect.Effect.Context<LifecycleOperation>
  >;
  readonly applies: number;
  readonly removeState: boolean;
}> = [
  { name: "stop", run: Effect.asVoid(stopAppForTarget({}, target)), applies: 1, removeState: false },
  {
    name: "destroy",
    run: Effect.asVoid(destroyAppForTarget({ volumes: true }, target)),
    applies: 1,
    removeState: true,
  },
  { name: "restart", run: Effect.asVoid(restartApp({}, target)), applies: 2, removeState: false },
  { name: "rebuild", run: Effect.asVoid(rebuildApp({}, target)), applies: 2, removeState: false },
];

for (const operation of operations) {
  for (const available of [false, true]) {
    test(`${operation.name} succeeds after ordinary fallback without provider sync hooks (adapter available: ${available})`, async () => {
      // Given: an accelerated desired plan, but a provider that can only apply ordinary mounts.
      const applied: AppPlan[] = [];
      const destroyed: boolean[] = [];
      const harness = makeHarness({
        plannedApp: planned,
        providerCanPrepareFileSync: false,
        providerCanInspectFileSync: false,
        fileSync: {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(available),
          listSessions: () => Effect.die("Ordinary providers must not inspect sync sessions"),
        },
        onApply: (next) => applied.push(next),
        onDestroy: (_target, options) => destroyed.push(options?.removeState === true),
      });
      try {
        await runStart(harness, planned);
        expect(applied[0]?.fileSync).toEqual([]);

        // When: a later lifecycle operation uses the original desired plan, not the applied fallback.
        await Effect.runPromise(operation.run.pipe(Effect.provide(harness.layer)));

        // Then: provider teardown runs, and any subsequent start still applies ordinary mounts.
        expect(destroyed).toEqual([operation.removeState]);
        expect(applied).toHaveLength(operation.applies);
        for (const next of applied) {
          expect(next.fileSync).toEqual([]);
          expect(next.services[web.name]?.appMount?.realization).toBe("passthrough");
        }
      } finally {
        rmSync(harness.userDataRoot, { recursive: true, force: true });
      }
    });
  }
}

for (const operation of operations.slice(0, 2)) {
  test(`${operation.name} still refuses an acceleration-capable provider without inspection`, async () => {
    // Given: this provider can prepare accelerated targets but cannot verify their applied state.
    let destroys = 0;
    const harness = makeHarness({
      plannedApp: planned,
      providerCanPrepareFileSync: true,
      providerCanInspectFileSync: false,
      onDestroy: () => destroys++,
    });
    try {
      // When: teardown is attempted without trustworthy applied-state evidence.
      const result = await Effect.runPromise(
        operation.run.pipe(Effect.either, Effect.provide(harness.layer)),
      );

      // Then: fail closed before touching the provider.
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("FileSyncStopError");
      expect(destroys).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}
