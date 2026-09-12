import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import { AppId, type LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { services } from "@lando/service-lando";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const legacy = "mysql-adoption-mysql-data";
const scoped = "mysql-adoption-db-mysql-data";

const plan = async (
  servicesInput: NonNullable<LandofileShape["services"]>,
  volumes: readonly string[],
  lookupFails = false,
) => {
  const calls: string[] = [];
  const provider = new Proxy(
    {
      ...TestRuntimeProvider,
      listVolumes: (filter: Parameters<typeof TestRuntimeProvider.listVolumes>[0]) => {
        if (lookupFails) {
          return Effect.fail(
            new ProviderInternalError({
              message: "Volume lookup failed",
              providerId: "test",
              operation: "listVolumes",
            }),
          );
        }
        return Effect.succeed(
          volumes
            .filter((store) => store === filter.store)
            .map((store) => ({ ref: { app: filter.app ?? AppId.make("mysql-adoption"), store } })),
        );
      },
    },
    {
      get(target, property, receiver) {
        calls.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const registry = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(provider),
  });
  calls.length = 0;
  const appPlan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(
        { name: "mysql-adoption", runtime: 4, services: servicesInput },
        TestRuntimeProvider.capabilities,
      ),
    ).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(Layer.mergeAll(services, PluginRegistryLive, registry)),
    ),
  );
  return { appPlan, calls };
};

describe("MySQL volume adoption through the real planner", () => {
  test.each(["mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7"])(
    "Given sole %s and only legacy storage, when planning, then it adopts without volume mutation",
    async (type) => {
      const { appPlan, calls } = await plan({ [ServiceName.make("db")]: { type } }, [legacy]);

      expect(appPlan.services[ServiceName.make("db")]?.storage[0]?.store).toBe(legacy);
      expect(appPlan.stores.map((store) => store.name)).toEqual([legacy]);
      expect(calls).toEqual(["listVolumes", "listVolumes"]);
    },
  );

  test.each([[legacy, scoped], [], [scoped]])(
    "Given scoped or fresh storage %j, when planning, then it uses the scoped identity",
    async (...volumes) => {
      const { appPlan } = await plan({ [ServiceName.make("db")]: { type: "mysql" } }, volumes);

      expect(appPlan.services[ServiceName.make("db")]?.storage[0]?.store).toBe(scoped);
      expect(appPlan.stores.map((store) => store.name)).toEqual([scoped]);
    },
  );

  test("Given two MySQL services and legacy storage, when planning, then it leaves legacy untouched", async () => {
    const { appPlan, calls } = await plan(
      {
        [ServiceName.make("db")]: { type: "mysql" },
        [ServiceName.make("analytics")]: { type: "mysql:9.7" },
      },
      [legacy],
    );

    expect(appPlan.services[ServiceName.make("db")]?.storage[0]?.store).toBe(scoped);
    expect(appPlan.services[ServiceName.make("analytics")]?.storage[0]?.store).toBe(
      "mysql-adoption-analytics-mysql-data",
    );
    expect(appPlan.stores.map((store) => store.name)).toEqual([
      scoped,
      "mysql-adoption-analytics-mysql-data",
    ]);
    expect(calls).toEqual([]);
  });

  test("Given a failed volume lookup, when planning, then it cannot silently select an empty store", async () => {
    await expect(plan({ [ServiceName.make("db")]: { type: "mysql" } }, [], true)).rejects.toThrow(
      /Volume lookup failed/,
    );
  });
});
