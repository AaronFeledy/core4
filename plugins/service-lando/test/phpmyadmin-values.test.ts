import { expect, test } from "bun:test";
import { type EnvironmentValue, ServiceConfig } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
} from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { phpMyAdminWireFeature } from "../src/services/phpmyadmin.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const reference = { _tag: "SecretRef", reference: "DB_PASSWORD" } as const;
const metadata = { resolvedAt: "2026-10-23T00:00:00Z", source: "/srv/myapp/.lando.yml", runtime: 4 } as const;

const database = async (
  name: string,
  password: EnvironmentValue,
  port = 3306,
): Promise<AppFeatureServiceView> => {
  const resolution = await Effect.runPromise(
    mysqlServiceType.resolve({
      name,
      appRoot: "/srv/myapp",
      metadata,
      service: Schema.decodeUnknownSync(ServiceConfig)({
        type: "mysql",
        port,
        creds: { user: "app", password, database: "app" },
      }),
    }),
  );
  return {
    serviceName: name,
    serviceType: "mysql",
    base: "lando",
    primary: false,
    featureIds: [],
    connection: resolution.connection,
    normalizedConfig: { type: "mysql", environment: { MYSQL_PASSWORD: "not-authority" } },
  };
};

const wire = (siblings: readonly AppFeatureServiceView[]) => {
  const pma: AppFeatureServiceView = {
    serviceName: "pma",
    serviceType: "phpmyadmin",
    base: "lando",
    primary: false,
    featureIds: [],
    normalizedConfig: {},
  };
  const selected = [pma, ...siblings];
  const environment: Record<string, EnvironmentValue> = {};
  const { ctx } = recordFeatureContext({ serviceType: "phpmyadmin", normalizedConfig: {}, config: {} });
  const mutator: AppFeatureServiceMutators = {
    ...ctx,
    service: pma,
    addEnv: (key, value) => {
      environment[key] = value;
    },
  };
  const context: AppFeatureContext = {
    featureId: phpMyAdminWireFeature.id,
    config: {},
    appName: "app",
    appRoot: "/srv/myapp",
    selected,
    forEachSelected: (apply) => apply(mutator),
    select: (name) => (name === "pma" ? mutator : undefined),
  };
  return { environment, apply: phpMyAdminWireFeature.apply(context) };
};

test.each([
  reference,
  {
    _tag: "BoundText",
    parts: ["prefix:", { reference: "DB_PASSWORD", encoding: "raw" }],
  } satisfies EnvironmentValue,
])("phpMyAdmin deliberately copies a typed canonical password", async (password) => {
  const siblings = [await database("first", password, 5544), await database("second", password)];
  const result = wire(siblings);
  await Effect.runPromise(result.apply);
  expect(result.environment.PMA_PASSWORD).toEqual(password);
  expect(result.environment.PMA_USER).toBe("app");
  expect(result.environment.PMA_PORTS).toBe("5544,3306");
});

test("phpMyAdmin fails incompatible discovered hosts before writing environment", async () => {
  const result = wire([await database("first", reference), await database("second", "private-incompatible")]);
  const exit = await Effect.runPromise(result.apply.pipe(Effect.result));
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") throw new Error("expected host credential conflict");
  expect(exit.failure._tag).toBe("PhpMyAdminHostsCredsError");
  expect(JSON.stringify(exit.failure)).not.toContain("private-incompatible");
  expect(result.environment).toEqual({});
});
