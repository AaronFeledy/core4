import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";

import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";
import { SqlConfirmRequiredError, SqlServiceAmbiguousError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { executeDbCommand } from "../src/run.ts";
import { DbCommandResult } from "../src/schemas.ts";
import { makeSqlTestDeps } from "./support/fakes.ts";

const decodeEnvelope = (encoded: string) =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(encoded));

describe("db command machine output", () => {
  test("encodes a successful export as a v4 command envelope", async () => {
    const secret = "s3cret-pass";
    const harness = makeSqlTestDeps({ password: secret });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(executeDbCommand(harness.deps, { action: "export", yes: false })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error("expected success");

    const encoded = await Effect.runPromise(
      encodeCommandResult({
        command: "db:export",
        resultSchema: DbCommandResult,
        outcome: { _tag: "success", value: exit.value },
        redactor: createRedactor("secrets", { values: [secret] }),
      }),
    );
    const envelope = decodeEnvelope(encoded);
    expect(envelope.apiVersion).toBe("v4");
    expect(envelope.command).toBe("db:export");
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toMatchObject({ service: "database", family: "mysql" });
    expect(encoded).not.toContain(secret);
    expect(harness.redactionTokens()).toContain(secret);
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
