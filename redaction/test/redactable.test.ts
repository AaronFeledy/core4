import { expect, test } from "bun:test";
import { inspect } from "node:util";
import { REDACTED } from "@lando/sdk/secrets";
import { Effect, Inspectable, Logger, Redactable } from "effect";
import { RedactionValues, createStandaloneRedactor } from "../src/service.ts";

test("redacts exact-match values in Effect logs and inspection", async () => {
  const secret = "canary-private-redaction-value-9147";
  const values = new RedactionValues([secret]);
  const records: string[] = [];
  const logger = Logger.make((options) => {
    records.push(Logger.formatJson.log(options));
  });

  await Effect.runPromise(Effect.log(values).pipe(Effect.provide(Logger.layer([logger]))));

  expect(Redactable.isRedactable(values)).toBe(true);
  expect([...values]).toEqual([secret]);
  expect(records).toHaveLength(1);
  for (const output of [
    records[0],
    Inspectable.toStringUnknown(values),
    JSON.stringify(values),
    String(values),
    inspect(values),
  ]) {
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(secret);
  }
  expect(values.toJSON()).toBe(REDACTED);
});

test("redacts a secret-carrying profile redactor in Effect logs and inspection", async () => {
  const secret = "canary-profile-redaction-value-1739";
  const redactor = createStandaloneRedactor("secrets", { redactionTokens: [secret] });
  const records: string[] = [];
  const logger = Logger.make((options) => {
    records.push(Logger.formatJson.log(options));
  });

  await Effect.runPromise(Effect.log(redactor).pipe(Effect.provide(Logger.layer([logger]))));

  expect(redactor.redactString(`input ${secret}`)).toBe(`input ${REDACTED}`);
  expect(records).toHaveLength(1);
  for (const output of [
    records[0],
    Inspectable.toStringUnknown(redactor),
    JSON.stringify(redactor),
    String(redactor),
    inspect(redactor),
  ]) {
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(secret);
  }
});
