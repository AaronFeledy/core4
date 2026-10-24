import { describe, expect, test } from "bun:test";
import { type Environment, type EnvironmentValue, ServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { serviceFeatures } from "../src/features/index.ts";
import { assertConnectionProjections } from "../src/services/_connection-helpers.ts";
import { credentialValuesAgree } from "../src/services/_creds-helpers.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mssqlServiceType } from "../src/services/mssql.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { redisServiceType } from "../src/services/redis.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const reference = { _tag: "SecretRef", reference: "DB_PASSWORD" } as const;
const bound = {
  _tag: "BoundText",
  parts: ["prefix:", { reference: "DB_PASSWORD", encoding: "raw" }, ":suffix"],
} as const;
const metadata = { resolvedAt: "2026-10-23T00:00:00Z", source: "/srv/myapp/.lando.yml", runtime: 4 } as const;
const resolve = (type: ServiceType, config: Record<string, unknown>) =>
  Effect.runPromise(
    type.resolve({
      name: "db",
      service: Schema.decodeUnknownSync(ServiceConfig)(config),
      appRoot: "/srv/myapp",
      appName: "myapp",
      metadata,
    }),
  );

const project = async (resolution: Awaited<ReturnType<typeof resolve>>) => {
  const featureRef = resolution.features[0];
  const feature = featureRef === undefined ? undefined : serviceFeatures.get(featureRef.id);
  if (feature === undefined) throw new Error("missing builtin database feature");
  const { ctx } = recordFeatureContext({
    serviceType: resolution.normalizedConfig.type ?? "",
    normalizedConfig: resolution.normalizedConfig,
    connection: resolution.connection,
    config: {},
  });
  const environment: Record<string, EnvironmentValue> = {};
  await Effect.runPromise(
    feature.apply({
      ...ctx,
      addEnv: (key, value) => {
        environment[key] = value;
      },
    }),
  );
  return environment;
};

const families = [
  { type: postgresServiceType, native: "POSTGRES_PASSWORD", client: "psql", clientKey: "PGPASSWORD" },
  { type: mysqlServiceType, native: "MYSQL_PASSWORD", client: "mysql", clientKey: "MYSQL_PWD" },
  { type: mariadbServiceType, native: "MARIADB_PASSWORD", client: "mariadb", clientKey: "MYSQL_PWD" },
  {
    type: mongodbServiceType,
    native: "MONGO_INITDB_ROOT_PASSWORD",
    client: "mongosh",
    clientKey: "MONGO_URI",
  },
  { type: mssqlServiceType, native: "SA_PASSWORD", client: "sqlcmd", clientKey: "SQLCMDPASSWORD" },
] as const;

describe("canonical typed connection projections", () => {
  for (const family of families) {
    for (const password of [reference, bound]) {
      for (const source of ["creds", "native"] as const) {
        test(`${family.type.id} copies ${password._tag} from ${source} to init, metadata and client`, async () => {
          const config =
            source === "creds"
              ? { creds: { user: family.type.id === "mssql" ? "sa" : "app", password, database: "appdb" } }
              : { environment: { [family.native]: password } };
          const resolution = await resolve(family.type, { type: family.type.id, port: 5544, ...config });
          const environment = await project(resolution);
          expect(resolution.connection).toMatchObject({
            family: family.type.id,
            port: 5544,
            creds: { password },
          });
          expect(environment[family.native]).toEqual(password);
          expect(environment.LANDO_DB_PASSWORD).toEqual(password);
          expect(environment.LANDO_DB_PORT).toBe("5544");
          const clientValue = resolution.tooling?.[family.client]?.env?.[family.clientKey];
          if (family.type.id === "mongodb") {
            expect(clientValue).toEqual({
              _tag: "BoundText",
              parts: [
                `mongodb://${source === "creds" ? "app" : "lando"}:${password === bound ? "prefix%3A" : ""}`,
                { reference: "DB_PASSWORD", encoding: "uri-component" },
                `${password === bound ? "%3Asuffix" : ""}@127.0.0.1:5544/${source === "creds" ? "appdb" : "myapp"}?authSource=admin`,
              ],
            });
          } else expect(clientValue).toEqual(password);
          const connection = resolution.connection;
          if (connection === undefined) throw new Error("missing connection");
          expect(() => assertConnectionProjections(connection, environment)).not.toThrow();
        });
      }
    }
  }

  test("feature uses the connection despite mutated normalized credentials", async () => {
    const resolution = await resolve(postgresServiceType, {
      type: "postgres",
      environment: { POSTGRES_PASSWORD: reference },
    });
    const environment = await project({
      ...resolution,
      normalizedConfig: { type: "postgres", environment: { POSTGRES_PASSWORD: "unrelated" } },
    });
    expect(environment.POSTGRES_PASSWORD).toEqual(reference);
    expect(environment.LANDO_DB_PASSWORD).toEqual(reference);
  });

  test.each(["MYSQL_PASSWORD", "LANDO_DB_PASSWORD", "MYSQL_PWD"])(
    "rejects a post-feature overwrite of %s without restoring a reference",
    async (key) => {
      const resolution = await resolve(mysqlServiceType, {
        type: "mysql",
        environment: { MYSQL_PASSWORD: reference },
      });
      const environment = await project(resolution);
      const overwritten: Environment = { ...environment, [key]: "${secret:DB_PASSWORD}" };
      const connection = resolution.connection;
      if (connection === undefined) throw new Error("missing connection");
      expect(() => assertConnectionProjections(connection, overwritten)).toThrow(`environment.${key}`);
      expect(overwritten[key]).toBe("${secret:DB_PASSWORD}");
    },
  );

  test("raw plugin strings stay literal and normalization compares descriptor meaning", async () => {
    const literal = "${secret:DB_PASSWORD}";
    const resolution = await resolve(postgresServiceType, {
      type: "postgres",
      environment: { POSTGRES_PASSWORD: literal },
    });
    expect((await project(resolution)).LANDO_DB_PASSWORD).toBe(literal);
    expect(credentialValuesAgree(reference, literal)).toBe(false);
    expect(
      credentialValuesAgree(reference, {
        _tag: "BoundText",
        parts: ["", { reference: "DB_PASSWORD", encoding: "raw" }],
      }),
    ).toBe(true);
  });

  for (const family of families) {
    test(`${family.type.id} rejects creds/native disagreement without exposing values`, async () => {
      const result = await Effect.runPromise(
        family.type
          .resolve({
            name: "db",
            appRoot: "/srv/myapp",
            metadata,
            service: Schema.decodeUnknownSync(ServiceConfig)({
              type: family.type.id,
              creds: {
                user: family.type.id === "mssql" ? "sa" : "app",
                password: "private-author",
                database: "app",
              },
              environment: { [family.native]: "private-native" },
            }),
          })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected credential conflict");
      expect(result.failure.message).toContain("creds.password");
      expect(result.failure.message).toContain(`environment.${family.native}`);
      expect(result.failure.message).not.toContain("private-author");
      expect(result.failure.message).not.toContain("private-native");
    });
  }

  test("native aliases agree by normalized descriptors", async () => {
    const resolution = await resolve(mariadbServiceType, {
      type: "mariadb",
      environment: {
        MYSQL_PASSWORD: reference,
        MARIADB_PASSWORD: { _tag: "BoundText", parts: [{ reference: "DB_PASSWORD", encoding: "raw" }] },
      },
    });
    expect(resolution.connection?.creds.password).toEqual(reference);
  });

  test("literal secret-looking text does not agree with reference authority", async () => {
    await expect(
      resolve(postgresServiceType, {
        type: "postgres",
        creds: { user: "app", password: reference, database: "app" },
        environment: { POSTGRES_PASSWORD: "${secret:DB_PASSWORD}" },
      }),
    ).rejects.toThrow("creds.password conflicts with environment.POSTGRES_PASSWORD");
  });

  test("disagreeing aliases name both paths without their values", async () => {
    await expect(
      resolve(mariadbServiceType, {
        type: "mariadb",
        environment: { MYSQL_PASSWORD: reference, MARIADB_PASSWORD: "private" },
      }),
    ).rejects.toThrow("environment.MYSQL_PASSWORD conflicts with environment.MARIADB_PASSWORD");
  });

  test.each(["POSTGRES_USER", "POSTGRES_DB"])("rejects a binding at literal-only %s", async (key) => {
    await expect(
      resolve(postgresServiceType, { type: "postgres", environment: { [key]: reference } }),
    ).rejects.toThrow("must be literal text");
  });

  test("mssql exposes sa with one effective password", async () => {
    const resolution = await resolve(mssqlServiceType, {
      type: "mssql",
      environment: { MSSQL_SA_PASSWORD: reference },
    });
    const environment = await project(resolution);
    expect(resolution.connection?.creds).toMatchObject({
      user: "sa",
      password: reference,
      rootPassword: reference,
    });
    expect(environment.SQLCMDPASSWORD).toEqual(reference);
    await expect(
      resolve(mssqlServiceType, {
        type: "mssql",
        creds: { user: "invented", password: reference, database: "app" },
      }),
    ).rejects.toThrow("administrator identity sa");
  });

  test.each([reference, bound])(
    "redis deliberately copies $._tag password into environment and generated client",
    async (password) => {
      const resolution = await resolve(redisServiceType, { type: "redis", password });
      expect(resolution.nonSqlCreds).toEqual({ user: "default", database: "0", password });
      expect(resolution.normalizedConfig.environment?.REDISCLI_AUTH).toEqual(password);
      expect(resolution.tooling?.["redis-cli"]?.env?.REDISCLI_AUTH).toEqual(password);
      expect((await project(resolution)).REDISCLI_AUTH).toEqual(password);
    },
  );
});
