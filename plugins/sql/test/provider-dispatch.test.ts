import { afterEach, expect, test } from "bun:test";
import { PortNumber } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";
import { providerSqlExec } from "../src/dispatch.ts";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";
import { sourcePlan } from "./support/source-plan.ts";
import { valueResolver } from "./support/value-resolver.ts";

afterEach(cleanupSqlTestDeps);

test("provider receives concrete CommandSpec credentials and the unchanged applied plan", async () => {
  const connection = {
    family: "postgres" as const,
    port: PortNumber.make(5544),
    creds: {
      user: "applied",
      database: "database",
      password: { _tag: "SecretRef" as const, reference: "DATABASE" },
    },
  };
  const harness = makeSqlTestDeps({
    password: "unused",
    connection,
    type: "postgres:17",
    observedVersion: "17.1",
  });
  const applied = sourcePlan(harness.root, "postgres:17");
  type ExecArgs = Parameters<RuntimeProvider["Service"]["exec"]>;
  const calls: Array<{ readonly target: ExecArgs[0]; readonly spec: ExecArgs[1] }> = [];
  const provider: Pick<RuntimeProvider["Service"], "exec"> = {
    exec: (target, spec) =>
      Effect.sync(() => {
        calls.push({ target, spec });
        return {
          exitCode: 0,
          stdout: spec.command.includes("SHOW server_version") ? "17.1" : "0",
          stderr: "",
        };
      }),
  };
  const values = valueResolver({ DATABASE: "resolved-only-at-dispatch" });
  await Effect.runPromise(
    executeDbCommand(
      { ...harness.deps, exec: providerSqlExec(provider, applied), environmentResolver: values.resolver },
      { action: "import", file: "dump.sql", yes: true },
    ),
  );
  expect(calls.length).toBeGreaterThan(2);
  for (const { target, spec } of calls) {
    expect(target.plan).toBe(applied);
    expect(spec.env).toEqual({ PGPASSWORD: "resolved-only-at-dispatch" });
    expect(spec.command).toContain("5544");
    expect(spec.command.join(" ")).not.toContain("resolved-only-at-dispatch");
  }
  expect(values.reads).toEqual(["DATABASE"]);
  expect(JSON.stringify(applied)).not.toContain("resolved-only-at-dispatch");
});
