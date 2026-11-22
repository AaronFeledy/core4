import { describe, expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import {
  CUSTOM_DB_EXTRA_ARGS_REMEDIATION,
  PORT_EXTRA_ARGS_REMEDIATION,
  firstReservedExtraArg,
  isNonCatalogArtifact,
} from "../src/services/_extra-args.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { memcachedServiceFeature } from "../src/services/memcached.ts";
import { minioServiceFeature } from "../src/services/minio.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { postgresServiceType } from "../src/services/postgres.ts";
import { redisServiceFeature } from "../src/services/redis.ts";
import { valkeyServiceFeature } from "../src/services/valkey.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const decode = (value: unknown) => Schema.decodeUnknownSync(ServiceConfig)(value);

const setCommandOptions = (calls: unknown[][]) => {
  const call = calls.find((entry) => entry[0] === "setCommand");
  expect(call).toBeDefined();
  const options = call?.[2] as { extraArgs?: (args: readonly string[]) => unknown } | undefined;
  const extraArgs = options?.extraArgs;
  expect(extraArgs).toBeTypeOf("function");
  if (typeof extraArgs !== "function") throw new Error("expected setCommand extraArgs checker");
  return extraArgs;
};

describe("extraArgs reserved-option scanner", () => {
  const portRules = [
    { form: "long" as const, name: "port", remediation: PORT_EXTRA_ARGS_REMEDIATION, takesValue: true },
    { form: "short" as const, name: "p", remediation: PORT_EXTRA_ARGS_REMEDIATION, takesValue: true },
  ];

  test("flags safe daemon options", () => {
    expect(firstReservedExtraArg(["--maxmemory", "64mb", "-m", "32"], portRules)).toBeUndefined();
  });

  test("detects long options with and without values", () => {
    expect(firstReservedExtraArg(["--maxmemory", "64mb", "--port", "6380"], portRules)).toEqual({
      index: 2,
      remediation: PORT_EXTRA_ARGS_REMEDIATION,
    });
    expect(firstReservedExtraArg(["--port=6380"], portRules)).toEqual({
      index: 0,
      remediation: PORT_EXTRA_ARGS_REMEDIATION,
    });
  });

  test("detects short options and attached values", () => {
    expect(firstReservedExtraArg(["-p", "11211"], portRules)).toEqual({
      index: 0,
      remediation: PORT_EXTRA_ARGS_REMEDIATION,
    });
    expect(firstReservedExtraArg(["-p11211"], portRules)).toEqual({
      index: 0,
      remediation: PORT_EXTRA_ARGS_REMEDIATION,
    });
  });

  test("does not treat --ports as --port", () => {
    expect(firstReservedExtraArg(["--ports", "1"], portRules)).toBeUndefined();
  });

  test("detects postgres -c port= and config_file=", () => {
    const rules = [
      { form: "postgres-c" as const, key: "port", remediation: "port" },
      { form: "postgres-c" as const, key: "config_file", remediation: "config" },
    ];
    expect(firstReservedExtraArg(["-c", "max_connections=200"], rules)).toBeUndefined();
    expect(firstReservedExtraArg(["-c", "port=5433"], rules)).toEqual({ index: 0, remediation: "port" });
    expect(firstReservedExtraArg(["-c", "config_file=/tmp/x"], rules)).toEqual({
      index: 0,
      remediation: "config",
    });
  });

  test("detects long-prefix defaults-* rules", () => {
    const rules = [{ form: "long-prefix" as const, prefix: "defaults-", remediation: "defaults" }];
    expect(firstReservedExtraArg(["--defaults-file=/tmp/my.cnf"], rules)).toEqual({
      index: 0,
      remediation: "defaults",
    });
    expect(firstReservedExtraArg(["--default-character-set=utf8"], rules)).toBeUndefined();
  });
});

describe("catalog extraArgs launchers", () => {
  test("memcached marks the port launcher and reserves -p/--port", async () => {
    const service = decode({ type: "memcached" });
    const { ctx, calls } = recordFeatureContext({
      serviceType: "memcached",
      normalizedConfig: service,
      config: {},
    });
    await Effect.runPromise(memcachedServiceFeature.apply(ctx));
    expect(calls.find((c) => c[0] === "setCommand")?.[1]).toEqual(["memcached", "-p", "11211"]);
    const extraArgs = setCommandOptions(calls);
    expect(extraArgs(["-m", "64"])).toBeUndefined();
    expect(extraArgs(["-p", "1"])).toMatchObject({ index: 0, remediation: PORT_EXTRA_ARGS_REMEDIATION });
    expect(extraArgs(["--port=1"])).toMatchObject({ index: 0 });
  });

  test("memcached does not mark an authored command", async () => {
    const service = decode({ type: "memcached", command: ["memcached", "-m", "128"] });
    const { ctx, calls } = recordFeatureContext({
      serviceType: "memcached",
      normalizedConfig: service,
      config: {},
    });
    await Effect.runPromise(memcachedServiceFeature.apply(ctx));
    const call = calls.find((c) => c[0] === "setCommand");
    expect(call?.[1]).toEqual(["memcached", "-m", "128"]);
    expect(call?.[2]).toBeUndefined();
  });

  test("valkey marks the launcher and reserves port/appendonly", async () => {
    const service = decode({ type: "valkey" });
    const { ctx, calls } = recordFeatureContext({
      serviceType: "valkey",
      normalizedConfig: service,
      config: {},
    });
    await Effect.runPromise(valkeyServiceFeature.apply(ctx));
    const extraArgs = setCommandOptions(calls);
    expect(extraArgs(["--maxmemory", "10mb"])).toBeUndefined();
    expect(extraArgs(["--port", "1"])).toMatchObject({ index: 0 });
    expect(extraArgs(["--appendonly", "no"])).toMatchObject({ index: 0 });
  });

  test("redis marks direct and auth launchers with managed reserved options", async () => {
    const plain = decode({ type: "redis", port: 6380 });
    const plainCtx = recordFeatureContext({
      serviceType: "redis",
      normalizedConfig: plain,
      config: {},
    });
    await Effect.runPromise(redisServiceFeature.apply(plainCtx.ctx));
    expect(plainCtx.calls.find((c) => c[0] === "setCommand")?.[1]).toEqual([
      "redis-server",
      "--appendonly",
      "yes",
      "--port",
      "6380",
    ]);
    const plainExtra = setCommandOptions(plainCtx.calls);
    expect(plainExtra(["--maxmemory", "10mb"])).toBeUndefined();
    expect(plainExtra(["--port", "1"])).toMatchObject({ index: 0 });
    expect(plainExtra(["--appendonly", "no"])).toMatchObject({ index: 0 });

    const auth = decode({ type: "redis", creds: { password: "secret" } });
    const authCtx = recordFeatureContext({
      serviceType: "redis",
      normalizedConfig: auth,
      config: {},
    });
    await Effect.runPromise(redisServiceFeature.apply(authCtx.ctx));
    const authCommand = authCtx.calls.find((c) => c[0] === "setCommand")?.[1] as string[];
    expect(authCommand[0]).toBe("sh");
    const authExtra = setCommandOptions(authCtx.calls);
    expect(authExtra(["--requirepass", "x"])).toMatchObject({ index: 0 });
  });

  test("minio default launcher uses sh -c script $0 so extraArgs append into $@", async () => {
    const service = decode({
      type: "minio",
      image: "minio/minio:RELEASE.2024-01-01T00-00-00Z",
    });
    const { ctx, calls } = recordFeatureContext({
      serviceType: "minio",
      normalizedConfig: service,
      config: { consolePort: 9001 },
    });
    await Effect.runPromise(minioServiceFeature.apply(ctx));
    const command = calls.find((c) => c[0] === "setCommand")?.[1] as string[];
    expect(command).toHaveLength(2);
    expect(command[0]).toContain('"$@"');
    expect(command[1]).toBe("minio");
    expect(calls.find((c) => c[0] === "setEntrypoint")?.[1]).toEqual(["/bin/sh", "-c"]);
    const extraArgs = setCommandOptions(calls);
    expect(extraArgs(["--quiet"])).toBeUndefined();
    expect(extraArgs(["--address", ":1"])).toMatchObject({ index: 0 });
    expect(extraArgs(["--console-address", ":1"])).toMatchObject({ index: 0 });
  });
});

describe("database extraArgs launchers", () => {
  test("postgres owns an args-only launcher when extraArgs is present", async () => {
    const service = decode({
      type: "postgres",
      extraArgs: ["-c", "max_connections=123"],
    });
    const resolution = await Effect.runPromise(
      postgresServiceType.resolve({
        name: "db",
        service,
        appRoot: "/srv/apps/myapp",
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
      }),
    );
    const { ctx, calls } = recordFeatureContext({
      serviceType: "postgres",
      normalizedConfig: resolution.normalizedConfig,
      config: {},
      connection: resolution.connection,
    });
    const { postgresServiceFeature } = await import("../src/services/postgres.ts");
    await Effect.runPromise(postgresServiceFeature.apply(ctx));
    expect(calls.find((c) => c[0] === "setCommand")?.[1]).toEqual(["postgres", "-c", "port=5432"]);
    const extraArgs = setCommandOptions(calls);
    expect(extraArgs(["-c", "max_connections=123"])).toBeUndefined();
    expect(extraArgs(["-c", "port=1"])).toMatchObject({ index: 0, remediation: PORT_EXTRA_ARGS_REMEDIATION });
    expect(extraArgs(["-p", "1"])).toMatchObject({ index: 0 });
  });

  test("mysql owns mysqld --port when extraArgs is present and reserves defaults-*", async () => {
    const service = decode({ type: "mysql", extraArgs: ["--max-connections=77"] });
    const resolution = await Effect.runPromise(
      mysqlServiceType.resolve({
        name: "db",
        service,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
      }),
    );
    const { ctx, calls } = recordFeatureContext({
      serviceType: "mysql",
      normalizedConfig: resolution.normalizedConfig,
      config: {},
      connection: resolution.connection,
    });
    const { mysqlServiceFeature } = await import("../src/services/mysql.ts");
    await Effect.runPromise(mysqlServiceFeature.apply(ctx));
    expect(calls.find((c) => c[0] === "setCommand")?.[1]).toEqual(["mysqld", "--port=3306"]);
    const extraArgs = setCommandOptions(calls);
    expect(extraArgs(["--max-connections=77"])).toBeUndefined();
    expect(extraArgs(["--defaults-file=/tmp/x"])).toMatchObject({ index: 0 });
    expect(extraArgs(["-P", "1"])).toMatchObject({ index: 0 });
  });

  test("mariadb and mongodb mark launchers for extraArgs", async () => {
    const mariadb = decode({ type: "mariadb", extraArgs: ["--max-connections=10"] });
    const mariadbResolution = await Effect.runPromise(
      mariadbServiceType.resolve({
        name: "db",
        service: mariadb,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
      }),
    );
    const mariadbCtx = recordFeatureContext({
      serviceType: "mariadb",
      normalizedConfig: mariadbResolution.normalizedConfig,
      config: {},
      connection: mariadbResolution.connection,
    });
    const { mariadbServiceFeature } = await import("../src/services/mariadb.ts");
    await Effect.runPromise(mariadbServiceFeature.apply(mariadbCtx.ctx));
    expect(mariadbCtx.calls.find((c) => c[0] === "setCommand")?.[1]).toEqual(["mariadbd", "--port=3306"]);
    setCommandOptions(mariadbCtx.calls);

    const mongo = decode({ type: "mongodb", extraArgs: ["--wiredTigerCacheSizeGB", "0.5"] });
    const mongoResolution = await Effect.runPromise(
      mongodbServiceType.resolve({
        name: "db",
        service: mongo,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
      }),
    );
    const mongoCtx = recordFeatureContext({
      serviceType: "mongodb",
      normalizedConfig: mongoResolution.normalizedConfig,
      config: {},
      connection: mongoResolution.connection,
    });
    const { mongodbServiceFeature } = await import("../src/services/mongodb.ts");
    await Effect.runPromise(mongodbServiceFeature.apply(mongoCtx.ctx));
    expect(mongoCtx.calls.find((c) => c[0] === "setCommand")?.[1]).toEqual(["mongod", "--port", "27017"]);
    const extraArgs = setCommandOptions(mongoCtx.calls);
    expect(extraArgs(["--port", "1"])).toMatchObject({ index: 0 });
    expect(extraArgs(["--config", "/tmp/x"])).toMatchObject({ index: 0 });
  });

  test("custom database images get a typed remediation and do not mark a launcher", async () => {
    expect(isNonCatalogArtifact({ image: "custom/postgres:16" }, ["postgres:16"])).toBe(true);
    expect(isNonCatalogArtifact({ image: "postgres:16" }, ["postgres:16"])).toBe(false);
    expect(isNonCatalogArtifact({ build: { context: "./db" } }, ["postgres:16"])).toBe(true);

    const advice = postgresServiceType.extraArgsRemediation;
    expect(typeof advice).toBe("function");
    expect(
      (advice as (config: ReturnType<typeof decode>) => string)(
        decode({ type: "postgres", image: "custom/pg:1" }),
      ),
    ).toBe(CUSTOM_DB_EXTRA_ARGS_REMEDIATION);

    const service = decode({
      type: "postgres",
      image: "custom/postgres:16",
      extraArgs: ["-c", "max_connections=10"],
    });
    const resolution = await Effect.runPromise(
      postgresServiceType.resolve({
        name: "db",
        service,
        appRoot: "/srv/apps/myapp",
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
      }),
    );
    const { ctx, calls } = recordFeatureContext({
      serviceType: "postgres",
      normalizedConfig: resolution.normalizedConfig,
      config: {},
      connection: resolution.connection,
    });
    const { postgresServiceFeature } = await import("../src/services/postgres.ts");
    await Effect.runPromise(postgresServiceFeature.apply(ctx));
    expect(calls.filter((c) => c[0] === "setCommand")).toEqual([]);
  });
});
