import { describe, expect, test } from "bun:test";
import {
  AppliedAppPlan,
  type BoundText,
  DatabaseConnection,
  Environment,
  EnvironmentValue,
  EventCmdStep,
  ServiceConfig,
  ServiceCredsDisplay,
  ServiceName,
  ToolingEnvironment,
  ToolingTaskShape,
  encodeUriComponent,
  normalizeEnvironmentValue,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each([
  { parts: ["a", "", "b"], normalized: "ab" },
  {
    parts: ["a", "", "b", { service: "web", encoding: "raw" }],
    normalized: { _tag: "RouteText", parts: ["ab", { service: "web", encoding: "raw" }] },
  },
])("normalizes public route text on decode and encode: $parts", ({ parts, normalized }) => {
  const decoded = Schema.decodeUnknownSync(EnvironmentValue)({ _tag: "RouteText", parts });
  expect(decoded).toEqual(normalized);
  expect(Schema.encodeSync(EnvironmentValue)(decoded)).toEqual(normalized);
});

describe("environment values", () => {
  test("normalizes event and tooling environments through the same descriptor codec", () => {
    // Given
    const input = { TOKEN: { _tag: "SecretRef", reference: "TOKEN" }, PORT: 5544, ENABLED: false };
    // When
    const event = Schema.decodeUnknownSync(EventCmdStep)({ cmd: "echo ready", env: input });
    const tooling = Schema.decodeUnknownSync(ToolingEnvironment)(input);
    // Then
    const expected = {
      TOKEN: { _tag: "SecretRef", reference: "TOKEN" },
      PORT: "5544",
      ENABLED: "false",
    } as const;
    expect(event.env).toEqual(expected);
    expect(tooling).toEqual(expected);
  });

  test.each([null, ["TOKEN"], { TOKEN: null }, JSON.parse('{"__proto__":"bad"}'), ["__proto__=bad"]])(
    "rejects invalid event environments: %j",
    (env) => {
      // Given / When
      const result = Schema.decodeUnknownResult(EventCmdStep)({ cmd: "echo ready", env });
      // Then
      expect(Result.isFailure(result)).toBe(true);
    },
  );

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
    const connection = Schema.decodeUnknownSync(DatabaseConnection)({
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

describe("applied route text", () => {
  // Applied state version 12 persists service environments: a record written before route facts
  // gained `member` and one written after must both decode strictly and encode back unchanged.
  const appliedPlan = (environment: Record<string, unknown>) => ({
    id: "demo",
    name: "demo",
    slug: "demo",
    root: "/app",
    provider: "lando",
    services: {
      web: {
        name: "web",
        type: "nginx",
        provider: "lando",
        primary: true,
        environment,
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
        extensions: {},
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
    extensions: {},
  });

  test.each([
    { name: "before route facts", parts: [{ service: "web", encoding: "raw" }, "/api"] },
    {
      name: "with route facts",
      parts: [
        { service: "web", member: "hostname", encoding: "raw" },
        ",",
        { service: "web", member: "origin", encoding: "uri-component" },
      ],
    },
  ])("decodes and re-encodes a record written $name", ({ parts }) => {
    // Given
    const record = appliedPlan({ APP: { _tag: "RouteText", parts } });
    // When
    const decoded = Schema.decodeUnknownSync(AppliedAppPlan)(record, { onExcessProperty: "error" });
    const encoded = Schema.encodeSync(AppliedAppPlan)(decoded);
    // Then
    expect(decoded.services[ServiceName.make("web")]?.environment.APP).toEqual({ _tag: "RouteText", parts });
    expect(Schema.decodeUnknownSync(AppliedAppPlan)(encoded, { onExcessProperty: "error" })).toEqual(decoded);
  });

  test("refuses an unknown route fact member", () => {
    const record = appliedPlan({
      APP: { _tag: "RouteText", parts: [{ service: "web", member: "port", encoding: "raw" }] },
    });
    expect(Result.isFailure(Schema.decodeUnknownResult(AppliedAppPlan)(record))).toBe(true);
  });
});
