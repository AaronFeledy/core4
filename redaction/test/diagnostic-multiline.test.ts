import { expect, test } from "bun:test";
import { encodeCommandResult } from "@lando/sdk/command-result";
import { DataTransferError, SqlCommandFailedError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { makeDiagnosticTail } from "../src/diagnostic-tail.ts";

const encoder = new TextEncoder();
const cases = [
  ["newline bearer", "Bearer\nprivate-bearer-token\n", "private-bearer-token"],
  ["multiline double quote", 'password="first\nprivate-double-value\nlast"\n', "private-double-value"],
  ["multiline single quote", "api_token='first\nprivate-single-value\nlast'\n", "private-single-value"],
  ["escaped multiline quote", 'password=\\"first\nprivate-escaped-value\\"\n', "private-escaped-value"],
  ["multiline UTF-8", 'password="é\nprivate-utf8-value\n界"\né clean\n', "private-utf8-value"],
  ["long quoted line", `password="${"a".repeat(9000)}private-line-value"\n`, "private-line-value"],
  ["oversized bearer whitespace", `Bearer${"\n".repeat(9000)}private-spaced-token\n`, "private-spaced-token"],
  ["oversized quoted value", `password="${"a\n".repeat(5000)}private-long-value"\n`, "private-long-value"],
  ["truncated identifier", `${"a".repeat(9000)}password="first\nprivate-key-value"\n`, "private-key-value"],
  [
    "exhausted bearer context",
    `Bearer${"\n".repeat(70000)}private-overflow-token\n`,
    "private-overflow-token",
  ],
  [
    "exhausted quoted context",
    `password="${"a\n".repeat(35000)}private-overflow-value"\n`,
    "private-overflow-value",
  ],
] as const;

for (const [name, input, secret] of cases) {
  for (const chunkSize of [1, 7, 8192, encoder.encode(input).length]) {
    test(`masks ${name} with ${chunkSize}-byte chunks`, async () => {
      // Given an unregistered canonical secret and a bounded collector.
      const tail = await Effect.runPromise(makeDiagnosticTail());
      const bytes = encoder.encode(input);

      // When stderr arrives across arbitrary byte boundaries.
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        tail.write(bytes.subarray(offset, offset + chunkSize));
      }
      const result = tail.finish() ?? "";
      const errors = [
        new DataTransferError({
          message: "Transfer failed",
          stderrTail: result,
          exitCode: 1,
          remediation: "Fix the transfer fixture command.",
        }),
        new SqlCommandFailedError({
          message: "SQL failed",
          service: "database",
          command: ["psql"],
          stderrTail: result,
          exitCode: 1,
          remediation: "Check credentials",
        }),
      ];
      const lines = errors.map((error) =>
        Effect.runSync(
          encodeCommandResult({
            command: "db:export",
            resultSchema: Schema.Unknown,
            outcome: { _tag: "failure", error, additionalErrors: [] },
            redactor: createRedactor("secrets"),
          }),
        ),
      );

      // Then no secret survives and the diagnostic remains byte bounded.
      expect(result).not.toContain(secret);
      expect(result).toContain(
        input.length > 65536 || name === "truncated identifier" ? "[diagnostic truncated]" : "[redacted]",
      );
      expect(encoder.encode(result).length).toBeLessThanOrEqual(8192);
      expect(result).not.toContain("�");
      if (name === "multiline UTF-8") expect(result).toContain("é clean");
      for (const error of errors) {
        expect(error.stderrTail).not.toContain(secret);
      }
      for (const line of lines) {
        expect(line).not.toContain(secret);
        const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
        expect(envelope.ok).toBe(false);
        expect(envelope.error?.stderrTail).toMatch(/\[(?:redacted|diagnostic truncated)\]/u);
      }
    });
  }
}

test("stays suppressed after context exhaustion across repeated writes", async () => {
  // Given a reusable input chunk larger in aggregate than the context budget.
  const tail = await Effect.runPromise(makeDiagnosticTail());
  const chunk = encoder.encode("diagnostic\n".repeat(1000));

  // When many chunks arrive followed by a secret-bearing continuation.
  for (let index = 0; index < 1000; index += 1) tail.write(chunk);
  tail.write(encoder.encode('password="first\nprivate-late-value"\n'));
  const result = tail.finish();

  // Then exhaustion is sticky, finish is stable, and no suffix can escape.
  expect(result).toBe("[diagnostic truncated]");
  expect(tail.finish()).toBe(result);
});
