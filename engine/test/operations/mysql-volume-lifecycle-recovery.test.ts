import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type AppPlan, PortNumber, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  physicalVolumeLockKey,
} from "@lando/sdk/services";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { attachEffectiveEvents, compiledEventsForPlan } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { serviceCredsScopeForPlan } from "../../src/planner/landofile-scopes.ts";
import { resolveMysqlVolumeTarget } from "../../src/planner/mysql-volume.ts";
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
  test("Given legacy storage, when resolving the MySQL target, then authored events follow the rewritten plan", async () => {
    // Given a plan with authored steps whose MySQL store resolves to the legacy volume
    const harness = makeHarness({ plannedApp: mysqlPlan, listVolumes: recoveredVolumes });
    const tooling = { cleanup: { cmd: "echo stopping", service: ":host" } };
    const credsScope = {
      db: {
        port: PortNumber.make(3306),
        creds: { user: "cleanup-user", database: "app", password: "secret" },
      },
    };
    const authored = attachEffectiveTooling(
      attachEffectiveEvents(
        {
          ...mysqlPlan,
          services: {
            [mysqlService.name]: { ...mysqlService, connection: { family: "mysql", ...credsScope.db } },
          },
        },
        { "pre-stop": [{ task: "cleanup" }] },
      ),
      tooling,
    );

    // When
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* resolveMysqlVolumeTarget({ ...target, plan: authored }, registry);
      }).pipe(Effect.provide(harness.layer)),
    );

    // Then
    expect(resolved.plan).not.toBe(authored);
    expect(resolved.plan.stores[0]?.name).toBe(legacy);
    expect(compiledEventsForPlan(resolved.plan)).toEqual(compiledEventsForPlan(authored));
    expect(effectiveToolingForPlan(resolved.plan)).toEqual(tooling);
    expect(serviceCredsScopeForPlan(resolved.plan)).toEqual(credsScope);
  });

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
