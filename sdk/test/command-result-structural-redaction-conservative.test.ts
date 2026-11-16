// The structural policy exempts a value only when every live schema candidate
// fixes it; these cases pin the positions that must stay redacted.
import { describe, expect, test } from "bun:test";
import { redactValueWithPolicy, structuralRedaction } from "@lando/sdk/command-result";
import { createRedactor } from "@lando/sdk/secrets";
import { Schema, SchemaTransformation } from "effect";

describe("conservative structural redaction", () => {
  test("uses the selected codec side without exempting the other side's literals", () => {
    const schema = Schema.Literal("wire-tag").pipe(
      Schema.decodeTo(
        Schema.Literal("runtime-tag"),
        SchemaTransformation.transform({
          decode: () => "runtime-tag" as const,
          encode: () => "wire-tag" as const,
        }),
      ),
    );
    const redactor = createRedactor("secrets", { values: ["wire-tag", "runtime-tag"] });

    for (const side of ["encoded", "type"] as const) {
      const policy = structuralRedaction(schema, side);
      expect([
        redactValueWithPolicy(redactor, policy, "wire-tag"),
        redactValueWithPolicy(redactor, policy, "runtime-tag"),
      ]).toEqual(side === "encoded" ? ["wire-tag", "[redacted]"] : ["[redacted]", "runtime-tag"]);
    }
  });

  test("a matching template member prevents a literal exemption", () => {
    const schema = Schema.Union([
      Schema.Literal("event.boot"),
      Schema.TemplateLiteral(["event.", Schema.String]),
    ]);
    const redactor = createRedactor("secrets", { values: ["event.boot"] });

    expect(redactValueWithPolicy(redactor, structuralRedaction(schema), "event.boot")).toBe("[redacted]");
  });

  test("redacts dynamic keys of a runtime value while declared keys survive", () => {
    // Given a record field whose key equals a registered value.
    const schema = Schema.Struct({
      kind: Schema.Literal("fields"),
      fields: Schema.Record(Schema.String, Schema.String),
    });
    const redactor = createRedactor("secrets", { values: ["private-key", "fields"] });

    // When
    const redacted = redactValueWithPolicy(redactor, structuralRedaction(schema, "type"), {
      kind: "fields",
      fields: { "private-key": "ok" },
    });

    // Then
    expect(JSON.parse(JSON.stringify(redacted))).toEqual({ kind: "fields", fields: { "[redacted]": "ok" } });
  });

  test("keeps an excess property redacted when another union member does not constrain it", () => {
    // Given a value both members accept, where only one member declares `a`.
    const schema = Schema.Union([
      Schema.Struct({ a: Schema.Literal("safe") }),
      Schema.Struct({ b: Schema.String }),
    ]);
    const redactor = createRedactor("secrets", { values: ["safe"] });

    // When
    const redacted = redactValueWithPolicy(redactor, structuralRedaction(schema), { a: "safe", b: "ok" });

    // Then
    expect(JSON.parse(JSON.stringify(redacted))).toEqual({ a: "[redacted]", b: "ok" });
  });

  test("treats a union too large to normalize as opaque", () => {
    // Given an unknown member hidden behind more literals than the normalization budget reads.
    const literals = Array.from({ length: 1100 }, (_, index) => Schema.Literal(`fixed-${index}`));
    const schema = Schema.Union([Schema.Unknown, ...literals]);
    const redactor = createRedactor("secrets", { values: ["fixed-1000"] });

    // When
    const redacted = redactValueWithPolicy(redactor, structuralRedaction(schema), "fixed-1000");

    // Then
    expect(redacted).toBe("[redacted]");
  });
});
