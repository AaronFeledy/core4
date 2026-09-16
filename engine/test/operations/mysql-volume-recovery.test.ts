import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { type RuntimeProviderShape, physicalVolumeLockKey } from "@lando/sdk/services";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { startApp } from "../../src/operations/start.ts";
import { adoptMysqlVolume } from "../../src/planner/mysql-volume.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

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
const unavailableVolumes: RuntimeProviderShape["listVolumes"] = () =>
  Effect.fail(
    new ProviderUnavailableError({
      message: "Provider remains unavailable.",
      providerId: "lando",
      operation: "listVolumes",
    }),
  );

describe("MySQL volume identity recovery before lifecycle coordination", () => {
  test("Given a recovered provider and legacy storage, when starting a supplied target, then it locks and applies the legacy volume", async () => {
    // Given
    let providerRecovered = false;
    let appliedStore: string | undefined;
    const locks: string[] = [];
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: (filter) => {
        if (filter.store === scoped) return Effect.succeed([]);
        if (!providerRecovered) {
          providerRecovered = true;
          return unavailableVolumes(filter);
        }
        return recoveredVolumes(filter);
      },
      onVolumeLock: (key) => locks.push(key),
      onApply: (appliedPlan) => {
        appliedStore = appliedPlan.stores[0]?.name;
      },
    });
    const offlinePlan = await Effect.runPromise(adoptMysqlVolume(mysqlPlan, harness.runtimeProviderRegistry));
    expect(offlinePlan.stores[0]?.name).toBe(scoped);

    // When
    await runStart(harness, offlinePlan);

    // Then
    expect(appliedStore).toBe(legacy);
    expect(locks).toContain(physicalVolumeLockKey(JSON.stringify(["endpoint:test", legacy])));
  });

  test("Given a recovered provider and legacy storage, when rebuilding one service from a supplied target, then it applies the legacy volume", async () => {
    // Given
    let appliedStore: string | undefined;
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: recoveredVolumes,
      onApply: (appliedPlan) => {
        appliedStore = appliedPlan.stores[0]?.name;
      },
    });

    // When
    await Effect.runPromise(rebuildApp({ services: [service] }, target).pipe(Effect.provide(harness.layer)));

    // Then
    expect(appliedStore).toBe(legacy);
  });

  test("Given a recovered provider and legacy storage, when fully rebuilding a supplied target, then restart applies the legacy volume", async () => {
    // Given
    let appliedStore: string | undefined;
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: recoveredVolumes,
      onApply: (appliedPlan) => {
        appliedStore = appliedPlan.stores[0]?.name;
      },
    });

    // When
    await Effect.runPromise(rebuildApp({}, target).pipe(Effect.provide(harness.layer)));

    // Then
    expect(appliedStore).toBe(legacy);
  });

  test("Given a provider that remains unavailable, when starting a supplied target, then it fails before apply", async () => {
    // Given
    let applied = false;
    const harness = makeHarness({
      plannedApp: mysqlPlan,
      listVolumes: unavailableVolumes,
      onApply: () => {
        applied = true;
      },
    });

    // When
    const result = await Effect.runPromise(
      startApp({}, target).pipe(Effect.provide(harness.layer), Effect.either),
    );

    // Then
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(ProviderUnavailableError);
    expect(applied).toBe(false);
  });
});
