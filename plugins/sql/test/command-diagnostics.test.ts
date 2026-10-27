import { afterEach, expect, test } from "bun:test";
import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { DataTransferError, SqlCommandFailedError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";
import { checkedSqlExecution } from "../src/checked-execution.ts";
import { SqlEnvironmentSession } from "../src/environment.ts";
import { executeDbCommand } from "../src/execute.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { valueResolver } from "./support/value-resolver.ts";

afterEach(cleanupSqlTestDeps);

test.each([
  { action: "import" as const, yes: false },
  { action: "import" as const, yes: true },
  { action: "seed" as const, yes: false },
])("preserves failed emptiness diagnostics for %j before any mutation", async ({ action, yes }) => {
  const harness = makeSqlTestDeps({ password: "count-private" });
  const exit = await Effect.runPromiseExit(
    executeDbCommand(
      {
        ...harness.deps,
        exec: (service, command, env) =>
          command.some((argument) => argument.includes("COUNT(*)"))
            ? Effect.succeed({
                exitCode: 23,
                stdout: "PRIVATE COUNT PAYLOAD",
                stderr: "count denied for count-private\n",
              })
            : harness.deps.exec(service, command, env),
      },
      { action, file: "dump.sql", yes },
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected count failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlCommandFailedError);
  expect(error).toMatchObject({ exitCode: 23, stderrTail: "count denied for [redacted]\n" });
  expect(JSON.stringify(error)).not.toContain("PRIVATE COUNT PAYLOAD");
  expect(JSON.stringify(error)).not.toContain("count-private");
  expect(harness.snapshots()).toEqual([]);
  expect(harness.transfers()).toEqual([]);
});

test("preserves a transfer failure as the primary error after recovery capture", async () => {
  const harness = makeSqlTestDeps({ password: "private" });
  const result = await Effect.runPromise(
    executeDbCommand(
      {
        ...harness.deps,
        transfer: () =>
          Effect.fail(
            new DataTransferError({
              message: "Database load failed",
              operation: "exec",
              exitCode: 5,
              stderrTail: "load failed: [redacted]",
              remediation: "Fix database credentials or the dump file, then retry import.",
            }),
          ),
      },
      { action: "import", file: "dump.sql", yes: true },
    ).pipe(Effect.result),
  );
  if (result._tag !== "Failure") throw new Error("expected failure");
  expect(result.failure).toMatchObject({
    _tag: "DataTransferError",
    exitCode: 5,
    stderrTail: "load failed: [redacted]",
    recoverySnapshotId: expect.stringMatching(/^snap-/u),
  });
});

test("a failed BACKUP after preparation never copies a stale backup", async () => {
  const harness = makeSqlTestDeps({
    type: "mssql:2022",
    password: "private",
  });
  const calls: string[] = [];
  const exit = await Effect.runPromiseExit(
    executeDbCommand(
      {
        ...harness.deps,
        exec: (service, command, env) => {
          calls.push(command.join(" "));
          return command.some((arg) => arg.startsWith("BACKUP DATABASE"))
            ? Effect.succeed({
                exitCode: 12,
                stdout: "PRIVATE BACKUP",
                stderr: "backup failed for private\n",
              })
            : harness.deps.exec(service, command, env);
        },
      },
      { action: "export", file: "dump.bak", yes: false },
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(SqlCommandFailedError);
  expect(error).toMatchObject({ exitCode: 12, stderrTail: expect.stringContaining("backup failed") });
  expect(JSON.stringify(error)).not.toContain("PRIVATE BACKUP");
  expect(JSON.stringify(error)).not.toContain("for private");
  expect(calls[0]).toContain("mkdir");
  expect(calls[1]).toContain("BACKUP DATABASE");
  expect(harness.transfers()).toEqual([]);
});

test("a failed RESTORE keeps its primary tag and safe diagnostics beside recovery context in JSON", async () => {
  const harness = makeSqlTestDeps({
    type: "mssql:2022",
    password: "private",
  });
  let uploaded = false;
  const exit = await Effect.runPromiseExit(
    executeDbCommand(
      {
        ...harness.deps,
        transfer: (spec) =>
          harness.deps.transfer(spec).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                uploaded = true;
              }),
            ),
          ),
        exec: (service, command, env) =>
          command.some((arg) => arg.startsWith("RESTORE DATABASE"))
            ? Effect.sync(() => {
                expect(uploaded).toBe(true);
                return { exitCode: 17, stdout: "PRIVATE DATABASE", stderr: "restore failed: private\n" };
              })
            : harness.deps.exec(service, command, env),
      },
      { action: "import", file: "dump.bak", yes: true },
    ),
  );
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
  const encoded = await Effect.runPromise(
    encodeCommandResult({
      command: "db:import",
      resultSchema: DbCommandResult,
      outcome: { _tag: "failure", error, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  expect(JSON.parse(encoded).error).toMatchObject({
    _tag: "SqlCommandFailedError",
    exitCode: 17,
    stderrTail: expect.stringContaining("restore failed"),
    recoverySnapshotId: expect.stringMatching(/^snap-/u),
  });
  expect(encoded).not.toContain("PRIVATE DATABASE");
  expect(encoded).not.toContain("failed: private");
  expect(harness.snapshots()).toHaveLength(1);
});

test("SQL execution failure is normalized without relabeling a provider message as stderr", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* valueResolver({}).resolver.openSession();
        return yield* checkedSqlExecution(Effect.fail("private provider error"), {
          service: "database",
          command: ["sqlcmd"],
        }).pipe(Effect.provideService(SqlEnvironmentSession, session), Effect.result);
      }),
    ),
  );
  if (result._tag !== "Failure") throw new Error("expected failure");
  if (!(result.failure instanceof SqlCommandFailedError)) throw new Error("expected SQL command failure");
  expect(result.failure._tag).toBe("SqlCommandFailedError");
  expect(result.failure.exitCode).toBeUndefined();
  expect(result.failure.stderrTail).toBeUndefined();
});
