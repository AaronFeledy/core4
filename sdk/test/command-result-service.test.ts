import { expect, test } from "bun:test";
import {
  buildCommandResultEnvelope,
  encodeCommandResult,
  encodeStreamResultFrame,
  identityRedactor,
} from "@lando/sdk/command-result";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

const options = (error: unknown) => ({
  command: "db:export",
  resultSchema: Schema.Unknown,
  outcome: { _tag: "failure", error, additionalErrors: [] } as const,
  redactor: identityRedactor,
});

for (const format of ["json", "yaml"] as const) {
  test(`preserves database service identity in a ${format} command failure`, () => {
    const error = new SqlCommandFailedError({
      message: "Database command failed.",
      service: "database",
      command: ["sqlcmd"],
      exitCode: 1,
      stderrTail: "backup denied\n",
      remediation: "Repair database access.",
    });

    const encoded = Effect.runSync(encodeCommandResult({ ...options(error), format }));
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(
      format === "json" ? JSON.parse(encoded) : Bun.YAML.parse(encoded),
    );

    expect(envelope.error).toMatchObject({
      _tag: "SqlCommandFailedError",
      service: "database",
      exitCode: 1,
      stderrTail: "backup denied\n",
    });
  });
}

test("preserves service identity in a terminal stream result", () => {
  const input = options({ _tag: "ExecutionError", message: "failed", service: "worker" });

  const encoded = Effect.runSync(encodeStreamResultFrame(input));
  const frame = Schema.decodeUnknownSync(StreamFrame)(JSON.parse(encoded));

  expect(frame).toMatchObject({ _tag: "result", envelope: { error: { service: "worker" } } });
});

test.each([
  { service: undefined },
  { service: null },
  { service: 42 },
  { service: {} },
  { service: ["worker"] },
  { service: "" },
])("omits malformed service metadata %p", ({ service }) => {
  const error = { _tag: "ExecutionError", message: "failed", service };

  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));

  expect(envelope.error).not.toHaveProperty("service");
});

test("does not evaluate an accessor to obtain service metadata", () => {
  let accesses = 0;
  const error = { _tag: "ExecutionError", message: "failed" };
  Object.defineProperty(error, "service", {
    enumerable: true,
    get: () => {
      accesses++;
      return "worker";
    },
  });

  const envelope = Effect.runSync(buildCommandResultEnvelope(options(error)));

  expect(envelope.error).not.toHaveProperty("service");
  expect(accesses).toBe(0);
});
