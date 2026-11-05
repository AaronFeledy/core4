import { expect, test } from "bun:test";
import { taggedErrorJson } from "@lando/sdk/command-result";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Schema } from "effect";

test("round-trips complete translation diagnostics through the tagged error schema and wire boundary", () => {
  // Given
  const diagnostics = [
    {
      kind: "unsupported" as const,
      sourceId: ConfigTranslateSourceId.make(".lando.local.yml"),
      keyPath: ["services", "db", "environment", 0],
      span: { start: { line: 3, column: 5 } },
      message: "Unresolved listener.",
      remediation: "Supply an explicit port.",
    },
  ];
  const error = new ConfigTranslateError({
    message: "Cannot write.",
    remediation: "Repair input.",
    diagnostics,
  });
  // When
  const encoded = Schema.encodeSync(ConfigTranslateError)(error);
  const decoded = Schema.decodeUnknownSync(ConfigTranslateError)(encoded);
  // Then
  expect(decoded.diagnostics).toEqual(diagnostics);
  expect(taggedErrorJson(decoded)).toHaveProperty("diagnostics", diagnostics);
  expect(decoded.diagnostics?.[0]?.keyPath).toEqual(["services", "db", "environment", 0]);
});

test("accepts a translation error without diagnostics", () => {
  // Given
  const wire = { _tag: "ConfigTranslateError", message: "Cannot parse.", remediation: "Repair input." };
  // When
  const decoded = Schema.decodeUnknownSync(ConfigTranslateError)(wire);
  // Then
  expect(decoded.diagnostics).toBeUndefined();
});

test("rejects malformed translation diagnostics at the error schema boundary", () => {
  // Given
  const wire = {
    _tag: "ConfigTranslateError",
    message: "Cannot write.",
    remediation: "Repair input.",
    diagnostics: [{ kind: "invalid", sourceId: ".lando.yml", keyPath: ["services", "db"], message: "Bad." }],
  };
  // When
  const result = Schema.decodeUnknownResult(ConfigTranslateError)(wire);
  // Then
  expect(result._tag).toBe("Failure");
});
