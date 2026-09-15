import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type AppPlan, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { type RuntimeProviderShape, physicalVolumeLockKey } from "@lando/sdk/services";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const service = ServiceName.make("db");
const scoped = "test-start-db-mysql-data";
const legacy = "test-start-mysql-data";
const mysqlService = {
  ...web,
  name: service,
  type: "mysql:9.7",
  artifact: { kind: "ref", ref: "mysql:9.7" },
  storage: [{ store: scoped, target: PortablePath.make("/var/lib/mysql"), readOnly: false }],
} satisfies ServicePlan;
const mysqlPlan: AppPlan = {
  ...plan,
  services: { [mysqlService.name]: mysqlService },
  stores: [{ name: scoped, scope: "service", kind: "data" }],
};
const target = {
  plan: mysqlPlan,
  root: mysqlPlan.root,
  app: { kind: "user" as const, id: mysqlPlan.id, root: mysqlPlan.root },
};
const recoveredVolumes: RuntimeProviderShape["listVolumes"] = (filter) =>
  Effect.succeed(
    filter.store === legacy ? [{ ref: { app: filter.app ?? mysqlPlan.id, store: legacy } }] : [],
  );

describe("MySQL volume identity recovery across destructive lifecycle operations", () => {
  test("Given a recovered provider and legacy storage, when restarting a supplied target, then it locks the legacy volume before stopping", async () => {
    // Given
    const locks: string[] = [];
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: recoveredVolumes,
      onVolumeLock: (key) => locks.push(key),
    });

    // When
    await Effect.runPromise(restartApp({}, target).pipe(Effect.provide(harness.layer)));

    // Then
    expect(locks[0]).toBe(physicalVolumeLockKey(JSON.stringify(["endpoint:test", legacy])));
  });

  test("Given a recovered provider and legacy storage, when stopping a supplied target, then it locks and stops with the legacy volume", async () => {
    // Given
    const destroyedStores: string[] = [];
    const locks: string[] = [];
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: recoveredVolumes,
      onVolumeLock: (key) => locks.push(key),
      onDestroy: ({ plan: destroyedPlan }) => {
        const store = destroyedPlan?.stores[0]?.name;
        if (store !== undefined) destroyedStores.push(store);
      },
    });

    // When
    await Effect.runPromise(stopApp({}, target).pipe(Effect.provide(harness.layer)));

    // Then
    expect(locks[0]).toBe(physicalVolumeLockKey(JSON.stringify(["endpoint:test", legacy])));
    expect(destroyedStores).toEqual([legacy]);
  });

  test("Given a recovered provider and legacy storage, when purging a supplied target, then it removes the legacy volume", async () => {
    // Given
    let purgedStore: string | undefined;
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: recoveredVolumes,
      onDestroy: ({ plan: destroyedPlan }, destroyOptions) => {
        if (destroyOptions.volumes) purgedStore = destroyedPlan?.stores[0]?.name;
      },
    });

    // When
    await Effect.runPromise(
      destroyAppForTarget({ volumes: true }, target).pipe(Effect.provide(harness.layer)),
    );

    // Then
    expect(purgedStore).toBe(legacy);
  });
});
