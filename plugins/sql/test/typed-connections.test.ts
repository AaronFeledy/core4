import { afterEach, expect, test } from "bun:test";
import { SecretStoreUnavailableError } from "@lando/sdk/errors";
import { type DatabaseConnection, PortNumber, ServiceName, encodeUriComponent } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { sourcePlan } from "./support/source-plan.ts";
import { valueResolver } from "./support/value-resolver.ts";

afterEach(cleanupSqlTestDeps);

const password = { _tag: "SecretRef", reference: "DATABASE" } as const;
const connection: DatabaseConnection = {
  family: "postgres",
  port: PortNumber.make(5544),
  creds: { user: "applied-user", database: "applied-db", password },
};
const failure = <A>(exit: Exit.Exit<A, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause));
};

test("exports the applied connection rather than desired credentials or native env", async () => {
  const harness = makeSqlTestDeps({
    password: "unused",
    type: "custom-database",
    connection,
    environment: { POSTGRES_PASSWORD: "wrong-env", LANDO_DB_PORT: "9999" },
  });
  const values = valueResolver({ DATABASE: "actual/secret" });
  const deps = {
    ...harness.deps,
    environmentResolver: values.resolver,
    landofile: {
      services: { database: { type: "mysql:8", creds: { user: "desired", password: "wrong-desired" } } },
    },
  };
  const result = await Effect.runPromise(
    Effect.scoped(executeDbCommand(deps, { action: "export", file: "out.sql", yes: true })),
  );
  expect(result.family).toBe("postgres");
  const endpoint = harness.transfers()[0]?.from;
  if (endpoint?._tag !== "serviceCmd") throw new Error("Expected database command");
  expect(endpoint.command).toEqual(["pg_dump", "-p", "5544", "-U", "applied-user", "-d", "applied-db"]);
  expect(endpoint.env).toEqual({ PGPASSWORD: "actual/secret" });
  expect(JSON.stringify(harness.deps.plan)).not.toContain("actual/secret");
  expect(JSON.stringify(endpoint.command)).not.toContain("actual/secret");
  expect(values.reads).toEqual(["DATABASE"]);
});

test("shares one scoped memo across count, version, readiness retries and import", async () => {
  const harness = makeSqlTestDeps({
    password: "unused",
    type: "postgres:17",
    connection,
    countFailuresBeforeSuccess: 2,
    observedVersion: "17.1",
  });
  const values = valueResolver({ DATABASE: "same-session-secret" });
  let closed = 0;
  const environmentResolver = {
    openSession: () =>
      Effect.acquireRelease(values.resolver.openSession(), () =>
        Effect.sync(() => {
          closed += 1;
        }),
      ),
  };
  const commands: Array<{
    readonly env?: Readonly<Record<string, string>>;
    readonly command: readonly string[];
  }> = [];
  let initialCount = true;
  const deps = {
    ...harness.deps,
    environmentResolver,
    exec: (service: string, command: readonly string[], env?: Readonly<Record<string, string>>) => {
      commands.push({ command, ...(env === undefined ? {} : { env }) });
      if (initialCount && command.some((argument) => argument.includes("COUNT(*)"))) {
        initialCount = false;
        return Effect.succeed({ exitCode: 0, stdout: "0", stderr: "" });
      }
      return harness.deps.exec(service, command, env);
    },
  };
  await Effect.runPromise(
    Effect.scoped(executeDbCommand(deps, { action: "import", file: "dump.sql", yes: true })),
  );
  expect(harness.countAttempts()).toBeGreaterThan(2);
  expect(commands.every((spec) => spec.env?.PGPASSWORD === "same-session-secret")).toBe(true);
  expect(harness.transfers()[0]?.to).toMatchObject({ env: { PGPASSWORD: "same-session-secret" } });
  expect(values.sessions()).toBe(1);
  expect(closed).toBe(1);
  expect(values.reads).toEqual(["DATABASE"]);
  await Effect.runPromise(
    Effect.scoped(executeDbCommand(deps, { action: "export", file: "next.sql", yes: true })),
  );
  expect(values.sessions()).toBe(2);
  expect(closed).toBe(2);
  expect(values.reads).toEqual(["DATABASE", "DATABASE"]);
});

test("uses one resolver session for source and target bindings during cross-app seed", async () => {
  const source = sourcePlan("/source", "postgres:17");
  const sourceService = source.services[ServiceName.make("database")];
  if (sourceService === undefined) throw new Error("Missing fixture service");
  const applied = { ...source, services: { database: { ...sourceService, connection } } };
  const harness = makeSqlTestDeps({
    password: "unused",
    type: "postgres:17",
    connection,
    observedVersion: "17.1",
    appliedPlans: Effect.succeed([applied]),
  });
  const values = valueResolver({ DATABASE: "shared-source-target" });
  await Effect.runPromise(
    Effect.scoped(
      executeDbCommand(
        { ...harness.deps, environmentResolver: values.resolver },
        { action: "seed", fromApp: "shop", yes: true },
      ),
    ),
  );
  const transfer = harness.transfers()[0];
  expect(transfer?.from).toMatchObject({ env: { PGPASSWORD: "shared-source-target" } });
  expect(transfer?.to).toMatchObject({ env: { PGPASSWORD: "shared-source-target" } });
  expect(values.sessions()).toBe(1);
  expect(values.reads).toEqual(["DATABASE"]);
});

test("preserves typed Mongo URI encoding until concrete command dispatch", async () => {
  const mongo: DatabaseConnection = {
    ...connection,
    family: "mongodb",
    creds: { ...connection.creds, user: "a@b", database: "db name" },
  };
  const harness = makeSqlTestDeps({ password: "unused", connection: mongo });
  const raw = "p:/?#'!\n☃";
  const values = valueResolver({ DATABASE: raw });
  await Effect.runPromise(
    Effect.scoped(
      executeDbCommand(
        { ...harness.deps, environmentResolver: values.resolver },
        { action: "export", file: "out.archive", yes: true },
      ),
    ),
  );
  const endpoint = harness.transfers()[0]?.from;
  if (endpoint?._tag !== "serviceCmd") throw new Error("Expected Mongo command");
  expect(endpoint.env?.MONGO_URI).toBe(
    `mongodb://a%40b:${encodeUriComponent(raw)}@127.0.0.1:5544/db%20name?authSource=admin`,
  );
  expect(values.environments[0]?.MONGO_URI).toEqual({
    _tag: "BoundText",
    parts: [
      "mongodb://a%40b:",
      { reference: "DATABASE", encoding: "uri-component" },
      "@127.0.0.1:5544/db%20name?authSource=admin",
    ],
  });
  expect(JSON.stringify(endpoint.command)).not.toContain(raw);
  expect(JSON.stringify(endpoint.command)).not.toContain(encodeUriComponent(raw));
});

test.each(["export", "import", "seed"] as const)(
  "propagates missing binding for %s without action or default credentials",
  async (action) => {
    const harness = makeSqlTestDeps({ password: "unused", connection });
    const values = valueResolver({});
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        executeDbCommand(
          { ...harness.deps, environmentResolver: values.resolver },
          { action, file: action === "export" ? "out.sql" : "dump.sql", yes: true },
        ),
      ),
    );
    expect(failure(exit)).toMatchObject({ _tag: "SecretNotFoundError", secret: "DATABASE" });
    expect(harness.transfers()).toEqual([]);
    expect(harness.snapshots()).toEqual([]);
    expect(harness.countAttempts()).toBe(0);
  },
);

test("propagates wrong-store errors before dispatch", async () => {
  const harness = makeSqlTestDeps({ password: "unused", connection });
  const error = new SecretStoreUnavailableError({
    message: "Store denied",
    storeId: "other",
    reason: "denied",
    remediation: "Select the configured store.",
  });
  const environmentResolver = {
    openSession: () => Effect.succeed({ resolveEnvironment: () => Effect.fail(error) }),
  };
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      executeDbCommand(
        { ...harness.deps, environmentResolver },
        { action: "import", file: "dump.sql", yes: true },
      ),
    ),
  );
  expect(failure(exit)).toBe(error);
  expect(harness.transfers()).toEqual([]);
  expect(harness.lifecycle()).toEqual([]);
});

test("requires replan for a legacy target before any action", async () => {
  const harness = makeSqlTestDeps({ password: "old-env" });
  const original = harness.deps.plan.services.database;
  if (original === undefined) throw new Error("Missing fixture service");
  const { connection: _connection, ...legacy } = original;
  const deps = { ...harness.deps, plan: { ...harness.deps.plan, services: { database: legacy } } };
  const exit = await Effect.runPromiseExit(
    Effect.scoped(executeDbCommand(deps, { action: "reset", yes: true })),
  );
  expect(failure(exit)).toMatchObject({
    _tag: "PlanReplanRequiredError",
    app: "sql-app",
    providerId: "test",
    remediation: expect.any(String),
  });
  expect(harness.lifecycle()).toEqual([]);
  expect(harness.execs()).toEqual([]);
});

test("requires source applied connection facts before seed inspects or mutates the target", async () => {
  const source = sourcePlan("/source");
  const service = source.services[ServiceName.make("database")];
  if (service === undefined) throw new Error("Missing fixture service");
  const { connection: _connection, ...legacy } = service;
  const harness = makeSqlTestDeps({
    password: "unused",
    appliedPlans: Effect.succeed([{ ...source, services: { database: legacy } }]),
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(executeDbCommand(harness.deps, { action: "seed", fromApp: "shop", yes: true })),
  );
  expect(failure(exit)).toMatchObject({ _tag: "PlanReplanRequiredError", app: "shop" });
  expect(harness.lifecycle()).toEqual([]);
  expect(harness.countAttempts()).toBe(0);
});
