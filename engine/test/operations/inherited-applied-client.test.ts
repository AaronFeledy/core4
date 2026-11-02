import { expect, test } from "bun:test";
import { CurrentExecutableAppPlan, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { attachEffectiveTooling, connectionClientsForPlan } from "../../src/planner/effective-tooling.ts";
import * as Planner from "../../src/services/planner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { inheritedServiceRegistry, planInherited } from "../planner/inherited-service-fixture.ts";
import { appliedClientFixture } from "./applied-client-fixture.ts";

test("real inherited PostgreSQL client invokes with applied drift without resolving absent desired reference", async () => {
  const inherited = await Effect.runPromise(
    planInherited("postgres", {
      creds: { user: "desired", database: "desired", password: "${secret:MISSING}" },
      port: 6543,
    }),
  );
  const persisted = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(
    JSON.parse(JSON.stringify(Schema.encodeSync(CurrentExecutableAppPlan)(inherited.plan))),
    { onExcessProperty: "error" },
  );
  const fixture = appliedClientFixture({
    inherited: { ...inherited, plan: persisted },
    missingDesired: true,
  });
  fixture.secretEnv.LANDO_SECRET_APPLIED = "fresh-applied-value";
  const result = await fixture.run();
  expect(result._tag).toBe("Success");
  expect(fixture.calls[0]).toMatchObject({
    command: ["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"],
    env: { PGPASSWORD: "fresh-applied-value" },
  });
});

test("strict persisted service records select the child's own factory through faithful registry lookup", async () => {
  const inherited = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const planner = yield* AppPlanner;
      const landofile = yield* compileTestLandofile({
        name: "child-factory-identity",
        services: {
          database: {
            type: "derived-postgres",
            home: false,
            port: 6543,
            creds: { user: "desired", database: "desired", password: "${secret:MISSING}" },
          },
        },
      });
      const planned = yield* planner.plan(landofile, TestRuntimeProvider.capabilities);
      const plan = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(
        JSON.parse(JSON.stringify(Schema.encodeSync(CurrentExecutableAppPlan)(planned))),
        { onExcessProperty: "error" },
      );
      const serviceType = yield* registry.loadServiceType("derived-postgres");
      return { plan, serviceType };
    }).pipe(
      Effect.provide(Planner.layer),
      Effect.provide(
        inheritedServiceRegistry("postgres", {}, (name, connection) => ({
          psql: {
            service: name,
            cmd: ["child-psql", "-p", String(connection.port)],
            env: { PGPASSWORD: connection.creds.password },
          },
        })),
      ),
    ),
  );
  const fixture = appliedClientFixture({ inherited, missingDesired: true });
  fixture.secretEnv.LANDO_SECRET_APPLIED = "fresh-child-applied-value";
  const result = await fixture.run();
  expect(result._tag).toBe("Success");
  expect(fixture.calls[0]).toMatchObject({
    command: ["child-psql", "-p", "5433"],
    env: { PGPASSWORD: "fresh-child-applied-value" },
  });
});

test("a service that lost client precedence at creation retains its own applied factory identity", async () => {
  // Given: alpha wins the original task, but database is independently planned.
  const inherited = await Effect.runPromise(
    Effect.gen(function* () {
      const planner = yield* AppPlanner;
      const registry = yield* PluginRegistry;
      const landofile = yield* compileTestLandofile({
        name: "lost-client-precedence",
        services: {
          alpha: { type: "postgres", home: false },
          database: { type: "derived-postgres", home: false },
        },
      });
      const plan = yield* planner.plan(landofile, TestRuntimeProvider.capabilities);
      const serviceType = yield* registry.loadServiceType("derived-postgres");
      return { plan, serviceType };
    }).pipe(
      Effect.provide(Planner.layer),
      Effect.provide(
        inheritedServiceRegistry("postgres", {}, (name, facts) => ({
          psql: { service: name, cmd: ["losing-child-psql", "-p", String(facts.port)] },
        })),
      ),
    ),
  );
  expect(connectionClientsForPlan(inherited.plan)).toEqual({ psql: ServiceName.make("alpha") });
  const database = inherited.plan.services[ServiceName.make("database")];
  if (database?.connection === undefined) throw new TypeError("Missing planned database connection");
  expect(database.type).toBe("postgres");
  // When: database becomes the desired winner; its original service record is reused as applied evidence.
  const desired = attachEffectiveTooling(
    inherited.plan,
    {
      psql: { service: "database", cmd: ["desired-client"] },
    },
    { psql: database.name },
  );
  const fixture = appliedClientFixture({ inherited: { ...inherited, plan: desired } });
  const result = await fixture.run();
  // Then: runtime dispatches the losing declaration's composed factory, not normalized postgres.
  expect(result._tag).toBe("Success");
  expect(fixture.calls[0]?.command).toEqual(["losing-child-psql", "-p", "5433"]);
});
