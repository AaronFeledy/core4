import { afterEach, expect, test } from "bun:test";
import { makeDiagnosticTail } from "@lando/redaction";
import { type DatabaseConnection, PortNumber, ServiceName, encodeUriComponent } from "@lando/sdk/schema";
import { Effect, Stream } from "effect";
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
  "registers literal password %s and unused root credentials before first exec and transfer",
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
                yield* safeDiagnostic([password, "unused-root-secret"]);
                checkedExec = true;
                return harness.deps.exec(service, command, env);
              }),
            ),
          transfer: (spec) =>
            safeDiagnostic([password, "unused-root-secret"]).pipe(
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
            yield* safeDiagnostic([raw, encodeUriComponent(raw), root, uri]);
            transferred = true;
            return yield* harness.deps.transfer(spec);
          }),
      },
      { action: "export", file: "dump.archive", yes: true },
    ),
  );
  expect(transferred).toBe(true);
  expect(values.reads).toEqual(["PASSWORD", "ROOT"]);
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
          safeDiagnostic([sourcePassword, sourceRoot, "target-password"]).pipe(
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
