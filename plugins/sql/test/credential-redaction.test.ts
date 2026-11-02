import { afterEach, expect, test } from "bun:test";
import { makeDiagnosticTail } from "@lando/redaction";
import { RedactionService } from "@lando/redaction/service";
import { SnapshotNotFoundError } from "@lando/sdk/errors";
import {
  type DatabaseConnection,
  type EnvironmentValue,
  PortNumber,
  ServiceName,
  encodeUriComponent,
} from "@lando/sdk/schema";
import { Effect, Schema, Stream } from "effect";
import { protectSqlEnvironment } from "../src/environment.ts";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { sourcePlan } from "./support/source-plan.ts";
import { valueResolver } from "./support/value-resolver.ts";

afterEach(cleanupSqlTestDeps);
const safeDiagnostic = (secrets: readonly string[]) =>
  Effect.gen(function* () {
    const tail = yield* makeDiagnosticTail();
    tail.write(new TextEncoder().encode(secrets.join("\n")));
    const safe = tail.finish() ?? "";
    for (const secret of secrets) expect(safe).not.toContain(secret);
  });

test.each(["lando", "x"])(
  "registers selected literal password %s before first exec and transfer",
  async (password) => {
    const connection: DatabaseConnection = {
      family: "postgres",
      port: PortNumber.make(5432),
      creds: { user: "user", database: "database", password, rootPassword: "unused-root-secret" },
    };
    const harness = makeSqlTestDeps({
      password: "unused",
      connection,
      type: "postgres:17",
      observedVersion: "17.1",
    });
    let checkedExec = false;
    let checkedTransfer = false;
    await Effect.runPromise(
      executeDbCommand(
        {
          ...harness.deps,
          exec: (service, command, env) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* safeDiagnostic([password]);
                checkedExec = true;
                return harness.deps.exec(service, command, env);
              }),
            ),
          transfer: (spec) =>
            safeDiagnostic([password]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  checkedTransfer = true;
                }),
              ),
              Effect.andThen(harness.deps.transfer(spec)),
            ),
        },
        { action: "import", file: "dump.sql", yes: true },
      ),
    );
    expect(checkedExec).toBe(true);
    expect(checkedTransfer).toBe(true);
  },
);

test("registers raw referenced Mongo password, encoded password and full emitted URI before transfer", async () => {
  const raw = "p:/?#'!\n☃";
  const root = "separate-root-secret";
  const connection: DatabaseConnection = {
    family: "mongodb",
    port: PortNumber.make(27017),
    creds: {
      user: "user",
      database: "database",
      password: { _tag: "SecretRef", reference: "PASSWORD" },
      rootPassword: { _tag: "SecretRef", reference: "ROOT" },
    },
  };
  const values = valueResolver({ PASSWORD: raw, ROOT: root });
  const harness = makeSqlTestDeps({
    password: "unused",
    connection,
    type: "mongodb:8",
    observedVersion: "8.0",
  });
  let transferred = false;
  await Effect.runPromise(
    executeDbCommand(
      {
        ...harness.deps,
        environmentResolver: values.resolver,
        transfer: (spec) =>
          Effect.gen(function* () {
            if (spec.from._tag !== "serviceCmd") throw new Error("Expected command source");
            const uri = spec.from.env?.MONGO_URI;
            if (uri === undefined) throw new Error("Expected resolved Mongo URI");
            yield* safeDiagnostic([raw, encodeUriComponent(raw), uri]);
            transferred = true;
            return yield* harness.deps.transfer(spec);
          }),
      },
      { action: "export", file: "dump.archive", yes: true },
    ),
  );
  expect(transferred).toBe(true);
  expect(values.reads).toEqual(["PASSWORD"]);
});

test("registers source seed credentials independently before source payload transfer", async () => {
  const source = sourcePlan("/source", "postgres:17");
  const service = source.services[ServiceName.make("database")];
  if (service === undefined || service.connection === undefined)
    throw new Error("Expected source connection");
  const sourcePassword = "source-referenced-secret";
  const sourceRoot = "source-root-secret";
  const applied = {
    ...source,
    services: {
      database: {
        ...service,
        connection: {
          ...service.connection,
          creds: {
            ...service.connection.creds,
            password: { _tag: "SecretRef" as const, reference: "SOURCE" },
            rootPassword: sourceRoot,
          },
        },
      },
    },
  };
  const harness = makeSqlTestDeps({
    password: "target-password",
    type: "postgres:17",
    observedVersion: "17.1",
    appliedPlans: Effect.succeed([applied]),
  });
  let transferred = false;
  await Effect.runPromise(
    executeDbCommand(
      {
        ...harness.deps,
        environmentResolver: valueResolver({ SOURCE: sourcePassword }).resolver,
        transfer: (spec) =>
          safeDiagnostic([sourcePassword, "target-password"]).pipe(
            Effect.andThen(
              Effect.sync(() => {
                transferred = true;
              }),
            ),
            Effect.andThen(harness.deps.transfer(spec)),
          ),
      },
      { action: "seed", fromApp: "shop", yes: true },
    ),
  );
  expect(transferred).toBe(true);
});

const credentialConnection = (
  family: DatabaseConnection["family"],
  password: EnvironmentValue,
  rootPassword: EnvironmentValue,
): DatabaseConnection => ({
  family,
  port: PortNumber.make(family === "mssql" ? 1433 : 3306),
  creds: { user: family === "mssql" ? "sa" : "lando", database: "sql-app", password, rootPassword },
});

const unusedCredentialCases: ReadonlyArray<{ readonly label: string; readonly password: EnvironmentValue }> =
  [
    { label: "literal lando", password: "lando" },
    { label: "literal x", password: "x" },
    { label: "missing reference", password: { _tag: "SecretRef", reference: "MISSING_APP" } },
  ];

for (const { label, password } of unusedCredentialCases) {
  test.each(["restore", "seed"] as const)(
    `unknown %s snapshot leaves unused ${label} out of the parent redactor`,
    async (action) => {
      const values = valueResolver({});
      const harness = makeSqlTestDeps({
        password: "unused",
        connection: credentialConnection("mysql", password, {
          _tag: "SecretRef",
          reference: "MISSING_ROOT",
        }),
      });
      let executions = 0;
      await Effect.runPromise(
        Effect.gen(function* () {
          const redaction = yield* RedactionService;
          yield* redaction.registerValues(["preexisting-secret"]);
          const redactor = yield* redaction.forProfile("secrets");
          const result = yield* executeDbCommand(
            {
              ...harness.deps,
              environmentResolver: values.resolver,
              listSnapshots: () => Effect.succeed([]),
              exec: (...args) => {
                executions += 1;
                return harness.deps.exec(...args);
              },
            },
            { action, snapshotId: "no-such-snapshot", yes: true },
          ).pipe(Effect.result);
          if (result._tag !== "Failure") throw new Error("Expected unknown snapshot rejection");
          if (!Schema.is(SnapshotNotFoundError)(result.failure))
            throw new Error("Expected SnapshotNotFoundError");
          expect(redactor.redactString(result.failure.remediation)).toBe(
            "Run `lando db:snapshots` to list snapshot ids and labels.",
          );
          expect(redactor.redactString("lando db:snapshots preexisting-secret x")).toBe(
            "lando db:snapshots [redacted] x",
          );
          // The same parent scope still serves the next metadata-only command.
          yield* executeDbCommand(
            { ...harness.deps, environmentResolver: values.resolver },
            { action: "snapshots", yes: true },
          );
          expect(redactor.redactString("lando db:snapshots")).toBe("lando db:snapshots");
        }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
      );
      expect(values.reads).toEqual([]);
      expect(executions).toBe(0);
      expect(harness.transfers()).toEqual([]);
      expect(harness.snapshots()).toEqual([]);
      expect(harness.restores()).toEqual([]);
      expect(harness.lifecycle()).toEqual([]);
    },
  );

  test(`refused reset does not resolve or register unused ${label}`, async () => {
    const values = valueResolver({});
    const harness = makeSqlTestDeps({
      password: "unused",
      connection: credentialConnection("mysql", password, {
        _tag: "SecretRef",
        reference: "MISSING_ROOT",
      }),
    });
    let executions = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const redaction = yield* RedactionService;
        const redactor = yield* redaction.forProfile("secrets");
        const result = yield* executeDbCommand(
          {
            ...harness.deps,
            environmentResolver: values.resolver,
            exec: (...args) => {
              executions += 1;
              return harness.deps.exec(...args);
            },
          },
          { action: "reset", yes: false },
        ).pipe(Effect.result);
        if (result._tag !== "Failure") throw new Error("Expected refused reset");
        expect(result.failure).toMatchObject({ _tag: "SqlConfirmRequiredError" });
        expect(redactor.redactString("lando db:snapshots x")).toBe("lando db:snapshots x");
      }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
    );
    expect(values.reads).toEqual([]);
    expect(executions).toBe(0);
    expect(harness.transfers()).toEqual([]);
    expect(harness.snapshots()).toEqual([]);
    expect(harness.lifecycle()).toEqual([]);
  });
}

test.each(["lando", "x"])(
  "direct export registers %s before transfer without changing its environment",
  async (password) => {
    const harness = makeSqlTestDeps({ password });
    let executions = 0;
    let transfers = 0;
    const result = await Effect.runPromise(
      executeDbCommand(
        {
          ...harness.deps,
          exec: (...args) => {
            executions += 1;
            return harness.deps.exec(...args);
          },
          transfer: (spec) =>
            Effect.gen(function* () {
              yield* safeDiagnostic([password]);
              if (spec.from._tag !== "serviceCmd") throw new Error("Expected command source");
              expect(spec.from.env).toEqual({ MYSQL_PWD: password });
              transfers += 1;
              return yield* harness.deps.transfer(spec);
            }),
        },
        { action: "export", file: "dump.sql", yes: true },
      ),
    );
    expect(executions).toBe(0);
    expect(transfers).toBe(1);
    expect(result.redactionTokens).toContain(password);
  },
);

test("failed first registration stays closed and cached while protecting known literals", async () => {
  const values = valueResolver({});
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* values.resolver.openSession();
      const protectedEnvironment = yield* protectSqlEnvironment(
        session,
        ["lando", { _tag: "SecretRef", reference: "MISSING_ROOT" }],
        { MYSQL_PWD: "lando" },
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* protectedEnvironment.session
          .resolveEnvironment({ MYSQL_PWD: "lando" })
          .pipe(Effect.result);
        if (result._tag !== "Failure") throw new Error("Expected unavailable credential");
        expect(result.failure).toMatchObject({ _tag: "SecretNotFoundError" });
        yield* safeDiagnostic(["lando"]);
      }
      expect(protectedEnvironment.tokens()).toEqual([]);
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
  expect(values.reads).toEqual(["MISSING_ROOT"]);
  expect(values.environments).toHaveLength(1);
});

test("missing selected reset credential blocks every raw execution and transfer", async () => {
  const values = valueResolver({});
  const harness = makeSqlTestDeps({
    password: "unused",
    connection: credentialConnection("mysql", "lando", { _tag: "SecretRef", reference: "MISSING_ROOT" }),
  });
  let executions = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* executeDbCommand(
        {
          ...harness.deps,
          environmentResolver: values.resolver,
          exec: (...args) => {
            executions += 1;
            return harness.deps.exec(...args);
          },
        },
        { action: "reset", yes: true },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      yield* safeDiagnostic(["lando"]);
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
  expect(values.reads).toEqual(["MISSING_ROOT"]);
  expect(executions).toBe(0);
  expect(harness.transfers()).toEqual([]);
  expect(harness.snapshots()).toEqual([]);
});

test("stopped snapshot registers the target before readiness and reuses it for version observation", async () => {
  const password = "stopped-runtime-secret";
  const values = valueResolver({ APP: password });
  const harness = makeSqlTestDeps({
    password: "unused",
    initiallyRunning: false,
    connection: credentialConnection(
      "mysql",
      { _tag: "SecretRef", reference: "APP" },
      { _tag: "SecretRef", reference: "MISSING_ROOT" },
    ),
  });
  const commands: Array<ReadonlyArray<string>> = [];
  await Effect.runPromise(
    executeDbCommand(
      {
        ...harness.deps,
        environmentResolver: values.resolver,
        exec: (service, command, env) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* safeDiagnostic([password]);
              expect(env).toEqual({ MYSQL_PWD: password });
              commands.push(command);
              return harness.deps.exec(service, command, env);
            }),
          ),
      },
      { action: "snapshot", yes: true },
    ),
  );
  expect(commands[0]?.join(" ")).toContain("SELECT COUNT(*)");
  expect(commands[1]?.join(" ")).toContain("SELECT VERSION()");
  expect(values.reads).toEqual(["APP"]);
  expect(values.environments.filter((environment) => "credential0" in environment)).toHaveLength(1);
  expect(harness.lifecycle()).toEqual(["lock", "resume", "suspend", "snapshot"]);
});

test.each(["snapshots", "prune"] as const)(
  "metadata action %s performs no credential lookup or execution",
  async (action) => {
    const values = valueResolver({});
    const harness = makeSqlTestDeps({
      password: "unused",
      connection: credentialConnection(
        "mysql",
        { _tag: "SecretRef", reference: "MISSING_APP" },
        { _tag: "SecretRef", reference: "MISSING_ROOT" },
      ),
    });
    let executions = 0;
    await Effect.runPromise(
      executeDbCommand(
        {
          ...harness.deps,
          environmentResolver: values.resolver,
          exec: (...args) => {
            executions += 1;
            return harness.deps.exec(...args);
          },
        },
        { action, preview: true, keepLatest: 2, yes: false },
      ),
    );
    expect(values.reads).toEqual([]);
    expect(executions).toBe(0);
  },
);

test("MySQL export ignores an unavailable unused root reference", async () => {
  const values = valueResolver({});
  const harness = makeSqlTestDeps({
    password: "unused",
    connection: credentialConnection("mysql", "app-literal", {
      _tag: "SecretRef",
      reference: "MISSING_ROOT",
    }),
  });
  await Effect.runPromise(
    executeDbCommand(
      { ...harness.deps, environmentResolver: values.resolver },
      { action: "export", file: "dump.sql", yes: true },
    ),
  );
  expect(values.reads).toEqual([]);
  expect(harness.transfers()).toHaveLength(1);
});

test("MSSQL resolves only its actual root credential when the unused app reference is missing", async () => {
  const values = valueResolver({ ROOT: "actual-root-secret" });
  const harness = makeSqlTestDeps({
    type: "mssql:2022",
    password: "unused",
    connection: credentialConnection(
      "mssql",
      { _tag: "SecretRef", reference: "MISSING_APP" },
      { _tag: "SecretRef", reference: "ROOT" },
    ),
  });
  await Effect.runPromise(
    executeDbCommand(
      { ...harness.deps, environmentResolver: values.resolver },
      { action: "export", file: "dump.bak", yes: true },
    ),
  );
  expect(values.reads).toEqual(["ROOT"]);
  expect(harness.transfers()).toHaveLength(1);
});

test.each(["mysql:8.0", "mariadb:10.6"])(
  "%s reset resolves app and root once and registers both before execution",
  async (type) => {
    const values = valueResolver({ APP: "actual-app-secret", ROOT: "actual-root-secret" });
    const harness = makeSqlTestDeps({
      type,
      observedVersion: type.startsWith("mariadb") ? "10.6.14-MariaDB" : "8.0",
      password: "unused",
      connection: credentialConnection(
        type.startsWith("mariadb") ? "mariadb" : "mysql",
        { _tag: "SecretRef", reference: "APP" },
        { _tag: "SecretRef", reference: "ROOT" },
      ),
    });
    let rootCommand = false;
    await Effect.runPromise(
      executeDbCommand(
        {
          ...harness.deps,
          environmentResolver: values.resolver,
          exec: (service, command, env) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* safeDiagnostic(["actual-app-secret", "actual-root-secret"]);
                if (env?.MYSQL_PWD === "actual-root-secret") rootCommand = true;
                return harness.deps.exec(service, command, env);
              }),
            ),
        },
        { action: "reset", yes: true },
      ),
    );
    expect(values.reads).toEqual(["APP", "ROOT"]);
    expect(values.environments.filter((environment) => "credential0" in environment)).toHaveLength(1);
    expect(rootCommand).toBe(true);
  },
);

test.each(["seeded", "nonempty"] as const)(
  "does not resolve source credentials when seed is %s",
  async (eligibility) => {
    const source = sourcePlan("/source", "postgres:17");
    const service = source.services[ServiceName.make("database")];
    if (service?.connection === undefined) throw new Error("Expected source connection");
    const applied = {
      ...source,
      services: {
        database: {
          ...service,
          connection: {
            ...service.connection,
            creds: {
              ...service.connection.creds,
              password: { _tag: "SecretRef" as const, reference: "MISSING_SOURCE" },
            },
          },
        },
      },
    };
    const values = valueResolver({});
    const harness = makeSqlTestDeps({
      type: "postgres:17",
      observedVersion: "17.1",
      password: "target-literal",
      seedStatus: eligibility === "seeded" ? "seeded" : "fresh",
      countStdout: eligibility === "nonempty" ? "1" : "0",
      appliedPlans: Effect.succeed([applied]),
    });
    const result = await Effect.runPromise(
      executeDbCommand(
        { ...harness.deps, environmentResolver: values.resolver },
        { action: "seed", fromApp: "shop", yes: true },
      ).pipe(Effect.result),
    );
    if (result._tag !== "Failure") throw new Error("Expected seed eligibility rejection");
    expect(result.failure).toMatchObject({ _tag: "SqlSeedStateError" });
    expect(values.reads).toEqual([]);
    expect(harness.transfers()).toEqual([]);
  },
);
