import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";

import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { SqlConfirmRequiredError, SqlServiceAmbiguousError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { type DbCommandInput, dbCommandRedactionTokens, executeDbCommand } from "../src/run.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

const decodeEnvelope = (encoded: string) =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(encoded));

const successInputs: ReadonlyArray<{ readonly command: string; readonly input: DbCommandInput }> = [
  { command: "db:export", input: { action: "export", yes: false } },
  { command: "db:import", input: { action: "import", file: "dump.sql.gz", yes: true } },
  { command: "db:snapshot", input: { action: "snapshot", label: "before-change", yes: false } },
  { command: "db:restore", input: { action: "restore", snapshotId: "before-change", yes: false } },
  { command: "db:reset", input: { action: "reset", yes: true } },
];

describe("db command machine output", () => {
  test("encodes every command result through the spec redactionTokens hook", async () => {
    const secret = "s3cret-pass";

    for (const { command, input } of successInputs) {
      const harness = makeSqlTestDeps({ password: secret });
      const exit = await Effect.runPromiseExit(Effect.scoped(executeDbCommand(harness.deps, input)));
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isFailure(exit)) throw new Error(`expected ${command} success`);

      const tokens = dbCommandRedactionTokens(exit.value);
      expect(tokens).toContain(secret);

      const encoded = await Effect.runPromise(
        encodeCommandResult({
          command,
          resultSchema: DbCommandResult,
          outcome: { _tag: "success", value: exit.value },
          redactor: createRedactor("secrets", { values: tokens }),
        }),
      );
      const envelope = decodeEnvelope(encoded);
      expect(envelope.apiVersion).toBe("v4");
      expect(envelope.command).toBe(command);
      expect(envelope.ok).toBe(true);
      expect(envelope.result).toMatchObject({ service: "database", family: "mysql" });
      expect(encoded).not.toContain(secret);
      expect(encoded).not.toContain("redactionTokens");
    }
  });

  test("encodes ambiguous-service and confirm-required failures with tags", async () => {
    const ambiguous = await Effect.runPromise(
      encodeCommandResult({
        command: "db:import",
        resultSchema: DbCommandResult,
        outcome: {
          _tag: "failure",
          error: new SqlServiceAmbiguousError({
            message: "Multiple SQL services are available.",
            available: ["analytics", "database"],
            remediation: "Pass --service <name>.",
          }),
        },
        redactor: identityRedactor,
      }),
    );
    const confirm = await Effect.runPromise(
      encodeCommandResult({
        command: "db:reset",
        resultSchema: DbCommandResult,
        outcome: {
          _tag: "failure",
          error: new SqlConfirmRequiredError({
            message: "Reset will destroy data in database.",
            service: "database",
            steps: [{ id: "reset", label: "reset database", target: "database", destructive: true }],
            remediation: "Re-run with --yes after reviewing the listed steps.",
          }),
        },
        redactor: identityRedactor,
      }),
    );

    const ambiguousEnvelope = decodeEnvelope(ambiguous);
    const confirmEnvelope = decodeEnvelope(confirm);
    expect(ambiguousEnvelope.ok).toBe(false);
    expect(confirmEnvelope.ok).toBe(false);
    expect(ambiguousEnvelope.error?._tag).toBe("SqlServiceAmbiguousError");
    expect(confirmEnvelope.error?._tag).toBe("SqlConfirmRequiredError");
  });
});
