import { describe, expect, test } from "bun:test";
import {
  type BoundText,
  Environment,
  EnvironmentValue,
  ServiceConfig,
  ServiceConnection,
  ServiceCredsDisplay,
  ToolingTaskShape,
  encodeUriComponent,
  normalizeEnvironmentValue,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("environment values", () => {
  test.each([
    "${secret:X}",
    { _tag: "SecretRef", reference: "X" },
    { _tag: "BoundText", parts: ["postgres://", { reference: "X", encoding: "uri-component" }, "@db"] },
  ] as const)("preserves literal and descriptor distinctions for %j", (input) => {
    // Given
    const schema = EnvironmentValue;
    // When
    const decoded = Schema.decodeUnknownSync(schema)(input);
    const roundtrip = Schema.decodeUnknownSync(schema)(
      JSON.parse(JSON.stringify(Schema.encodeSync(schema)(decoded))),
    );
    // Then
    expect(roundtrip).toEqual(input);
  });

  test.each([
    { parts: ["a", "", "b"], expected: "ab" },
    { parts: [], expected: "" },
    { parts: [{ reference: "X", encoding: "raw" }], expected: { _tag: "SecretRef", reference: "X" } },
    {
      parts: ["", { reference: "X", encoding: "uri-component" }, "a", "b"],
      expected: { _tag: "BoundText", parts: [{ reference: "X", encoding: "uri-component" }, "ab"] },
    },
  ] as const)("normalizes flat parts $parts", ({ parts, expected }) => {
    // Given
    const value: BoundText = { _tag: "BoundText", parts };
    // When
    const normalized = normalizeEnvironmentValue(value);
    // Then
    expect(normalized).toEqual(expected);
    expect(Schema.decodeUnknownSync(EnvironmentValue)(value)).toEqual(expected);
  });

  test.each([
    { _tag: "SecretRef", reference: "../invalid" },
    { _tag: "SecretRef", reference: " X " },
    { _tag: "BoundText", parts: [{ _tag: "SecretRef", reference: "X" }] },
    { _tag: "BoundText", parts: [{ reference: "X", encoding: "base64" }] },
    { _tag: "BoundText", parts: Array(10_001).fill("x") },
    "x".repeat(1_048_577),
  ])("rejects invalid or over-budget descriptors", (value) => {
    // Given / When
    const result = Schema.decodeUnknownResult(EnvironmentValue)(value);
    // Then
    expect(Result.isFailure(result)).toBe(true);
  });

  test("shares one environment value model across service, tooling and database facts", () => {
    // Given
    const password = { _tag: "SecretRef", reference: "op://vault/db/password" } as const;
    const environment = { PASSWORD: password, LITERAL: "${secret:X}" };
    // When
    const service = Schema.decodeUnknownSync(ServiceConfig)({
      environment: { ...environment, PORT: 5544, ENABLED: true },
      password,
    });
    const tooling = Schema.decodeUnknownSync(ToolingTaskShape)({ cmd: "psql", env: environment });
    const connection = Schema.decodeUnknownSync(ServiceConnection)({
      family: "postgres",
      port: 5544,
      creds: { user: "alice", password, database: "db" },
    });
    // Then
    expect(service.environment).toEqual({ ...environment, PORT: "5544", ENABLED: "true" });
    expect(tooling.env).toEqual(environment);
    expect(connection.creds.password).toEqual(password);
    expect(connection.port).toBe(5544);
    expect(Schema.decodeUnknownSync(Environment)(environment)).toEqual(environment);
    expect(Result.isFailure(Schema.decodeUnknownResult(ServiceCredsDisplay)(connection.creds))).toBe(true);
  });

  test("encodes RFC3986 UTF8 component bytes explicitly", () => {
    // Given
    const literal = "p !'()*:/@é😀";
    // When
    const encoded = encodeUriComponent(literal);
    // Then
    expect(encoded).toBe("p%20%21%27%28%29%2A%3A%2F%40%C3%A9%F0%9F%98%80");
    expect(encodeUriComponent("AZaz09-._~")).toBe("AZaz09-._~");
  });
});
