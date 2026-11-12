import { describe, expect, test } from "bun:test";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import { physicalVolumeLockKey } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const coordinationKey = (store: string) => JSON.stringify(["endpoint:test", store]);
const adminer = {
  ...web,
  name: ServiceName.make("adminer"),
  primary: false,
  endpoints: [],
  routes: [],
};
const desired: AppPlan = {
  ...plan,
  services: { [web.name]: web },
  stores: [{ name: "alpha-web", scope: "app", kind: "data" }],
};
// The applied plan still has the service and store the desired plan dropped.
const applied: AppPlan = {
  ...plan,
  services: { [web.name]: web, [adminer.name]: adminer },
  stores: [
    { name: "alpha-web", scope: "app", kind: "data" },
    { name: "zeta-adminer", scope: "app", kind: "data" },
  ],
};
const target: ResolvedAppTarget = {
  plan: desired,
  root: desired.root,
  app: { kind: "user", id: desired.id, root: desired.root },
};
const alphaLock = physicalVolumeLockKey(coordinationKey("alpha-web"));
const zetaLock = physicalVolumeLockKey(coordinationKey("zeta-adminer"));
const volumeLocks = (keys: ReadonlyArray<string>) =>
  keys.filter((key) => key === alphaLock || key === zetaLock);

type Operation = (harness: ReturnType<typeof makeHarness>) => Effect.Effect<unknown, unknown, never>;

const makeScenario = (options: {
  readonly preTag: "pre-rebuild" | "pre-restart";
  readonly mutateInsideHalt: boolean;
}) => {
  const locked: string[] = [];
  let lockedBeforeHalt: ReadonlyArray<string> = [];
  let replaced = false;
  const harness = makeHarness({
    plannedApp: desired,
    appliedPlans: [applied],
    resolveAppliedPlan: () => Effect.succeed(applied),
    locateVolume: (ref) => {
      const nativeName = replaced && ref.store === "zeta-adminer" ? "zeta-adminer-replaced" : ref.store;
      const coordination = coordinationKey(ref.store);
      return Effect.succeed({
        coordinationKey: coordination,
        nativeName,
        identity: {
          coordinationKey: coordination,
          nativeName,
          generation: "00000000-0000-4000-8000-000000000001",
          ownerRoot: desired.root,
          origin: "created" as const,
        },
      });
    },
    onVolumeLock: (key) => {
      locked.push(key);
    },
    onPublish: (event) => {
      if (event._tag === options.preTag) {
        lockedBeforeHalt = [...locked];
        replaced = options.mutateInsideHalt;
      }
      return Effect.void;
    },
  });
  return { harness, locked, beforeHalt: () => lockedBeforeHalt };
};

const operations: ReadonlyArray<{
  readonly name: string;
  readonly preTag: "pre-rebuild" | "pre-restart";
  readonly effect: Operation;
}> = [
  {
    name: "rebuild",
    preTag: "pre-rebuild",
    effect: (harness) => rebuildApp({}, target).pipe(Effect.provide(harness.layer)),
  },
  {
    name: "restart",
    preTag: "pre-restart",
    effect: (harness) => restartApp({}, target).pipe(Effect.provide(harness.layer)),
  },
];

describe("whole-app lifecycle with a removed service", () => {
  for (const operation of operations) {
    test(`${operation.name} locks the desired and applied volume union once before halting`, async () => {
      // Given an applied app with a service and store the desired plan no longer has.
      const scenario = makeScenario({ preTag: operation.preTag, mutateInsideHalt: false });

      // When the whole app is rebuilt or restarted.
      const outcome = await Effect.runPromise(
        Effect.result(operation.effect(scenario.harness)).pipe(Effect.timeout("10 seconds")),
      );

      // Then it completes and both physical keys were acquired exactly once, before the halt event.
      expect(outcome._tag).toBe("Success");
      expect(volumeLocks(scenario.locked)).toEqual([alphaLock, zetaLock]);
      expect(volumeLocks(scenario.beforeHalt())).toEqual([alphaLock, zetaLock]);
    });

    test(`${operation.name} verifies the removed service's stores inside the halt`, async () => {
      // Given the applied plan's removed store changes identity after the pre-halt event.
      const scenario = makeScenario({ preTag: operation.preTag, mutateInsideHalt: true });

      // When the whole app is rebuilt or restarted.
      const outcome = await Effect.runPromise(
        Effect.result(operation.effect(scenario.harness)).pipe(Effect.timeout("10 seconds")),
      );

      // Then halt-time verification covers the union and fails on the removed service's store.
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.failure).toMatchObject({
          _tag: "VolumeOperationError",
          operation: "coordinateVolume",
        });
        expect(outcome.failure instanceof Error ? outcome.failure.message : "").toContain("zeta-adminer");
      }
    });
  }
});
