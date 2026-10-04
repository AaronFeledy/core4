import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { REDACTED, createRedactor, createSecretRedactor } from "@lando/sdk/secrets";
import { Effect, Formatter, Inspectable, Logger, Redactable } from "effect";

test.each(["exact", "profile"] as const)(
  "redacts inspection and Effect logs when a %s redactor retains secrets",
  async (kind) => {
    // Given
    const raw = "private-inspection-secret-3928";
    const value =
      kind === "exact" ? createSecretRedactor([raw]) : createRedactor("secrets", { values: [raw] });
    const logs: string[] = [];
    const logger = Logger.make((options) => {
      logs.push(Logger.formatJson.log(options));
    });
    // When
    await Effect.runPromise(Effect.log(value).pipe(Effect.provide(Logger.layer([logger]))));
    const surfaces = [
      Redactable.redact(value),
      Inspectable.toJson(value),
      Formatter.format(value),
      value.toJSON(),
      String(value),
      inspect(value),
      JSON.stringify(value),
    ];
    // Then
    expect(logs).toHaveLength(1);
    for (const surface of [...surfaces, ...logs]) {
      expect(String(surface)).toContain(REDACTED);
      expect(String(surface)).not.toContain(raw);
    }
  },
);
