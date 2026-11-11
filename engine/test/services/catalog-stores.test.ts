import { expect, test } from "bun:test";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { services } from "@lando/service-lando";
import { Effect, Layer } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { planTestLandofile } from "../compiled-landofile.ts";

const plan = (document: LandofileShape) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planTestLandofile(planner, document, TestRuntimeProvider.capabilities),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(Layer.merge(services, PluginRegistryLayer.layer)),
    ),
  );

test("#2016 gives two Postgres services in one app distinct data stores", async () => {
  const app = await plan({
    name: "twopg",
    services: {
      [ServiceName.make("db1")]: { type: "postgres", home: false },
      [ServiceName.make("db2")]: { type: "postgres", home: false },
    },
  });

  expect(app.stores.map((store) => store.name)).toEqual([
    "lando-twopg--db1--postgresql-data",
    "lando-twopg--db2--postgresql-data",
  ]);
  for (const name of ["db1", "db2"]) {
    expect(
      app.services[ServiceName.make(name)]?.mounts.find(
        (mount) => mount.type === "volume" && mount.target === "/var/lib/postgresql/data",
      ),
    ).toMatchObject({ store: `lando-twopg--${name}--postgresql-data` });
  }
});

test("plans a valid engine data volume name for My App", async () => {
  const app = await plan({
    name: "My App",
    services: { [ServiceName.make("db")]: { type: "postgres", home: false } },
  });

  expect(app.slug).toBe("my-app");
  expect(app.stores).toHaveLength(1);
  expect(app.stores[0]?.name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
  expect(app.stores[0]?.name).toBe("lando-my-app--db--postgresql-data");
});
