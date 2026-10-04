import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { Effect, Formatter, Inspectable, Logger, Redactable } from "effect";
import { makeOpRunner } from "../src/op-cli.ts";

test("process results preserve raw output while redacting inspection and Effect logs", async () => {
  // Given
  const stdout = "private-password-output-3928";
  const stderr = "private-password-error-8742";
  const run = makeOpRunner({
    run: () => Effect.succeed({ exitCode: 0, stdout, stderr }),
  });
  const logs: string[] = [];
  const logger = Logger.make((options) => {
    logs.push(Logger.formatJson.log(options));
  });

  // When
  const result = await Effect.runPromise(run(["read", "op://Vault/Item/field"], { timeoutMs: 37 }));
  await Effect.runPromise(Effect.log(result).pipe(Effect.provide(Logger.layer([logger]))));
  const surfaces = [
    Redactable.redact(result),
    Inspectable.toJson(result),
    Formatter.format(result),
    String(result),
    inspect(result),
    JSON.stringify(result),
    ...logs,
  ];

  // Then
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe(stderr);
  expect(logs).toHaveLength(1);
  for (const surface of surfaces) {
    expect(String(surface)).toContain("[redacted]");
    expect(String(surface)).not.toContain(stdout);
    expect(String(surface)).not.toContain(stderr);
  }
});
