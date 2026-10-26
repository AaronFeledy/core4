import { describe, expect, test } from "bun:test";
import { Result, Schema, SchemaIssue } from "effect";
import * as AST from "effect/SchemaAST";

import { HealthcheckInput, ServiceConfig } from "../../src/schema/landofile.ts";

// allow: SIZE_OK — this is a pure fixture-table test file kept together for contract readability.
type AcceptedFixture = Readonly<{
  name: string;
  input: unknown;
  expected: false | Readonly<Record<string, unknown>>;
}>;
type RejectedFixture = Readonly<{ name: string; input: unknown; expectedErrorFragment: string }>;

const ignoredComposeKeys = {
  test: ["FOO", "x"],
  disable: "yes",
  interval: "bad",
  timeout: "bad",
  start_period: "bad",
} as const;

const composeHealthcheckFixtures = [
  { name: "false disables the probe", input: false, expected: false },
  {
    name: "string is a shell command",
    input: "pg_isready",
    expected: { kind: "command", command: "pg_isready" },
  },
  {
    name: "bare argv keeps Compose markers literal",
    input: ["CMD", "true"],
    expected: { kind: "command", command: ["CMD", "true"] },
  },
  { name: "bare NONE is an executable", input: ["NONE"], expected: { kind: "command", command: ["NONE"] } },
  {
    name: "none drops probe targets and timings",
    input: { kind: "none", command: "x", url: "http://x", port: 80, intervalSeconds: 2, startInterval: "5s" },
    expected: false,
  },
  {
    name: "disable ignores test and timings",
    input: { disable: true, test: "x", interval: "5s", start_interval: "1s" },
    expected: false,
  },
  { name: "empty shorthand string", input: "", expectedErrorFragment: "must not be empty" },
  { name: "empty shorthand argv", input: [], expectedErrorFragment: "must not be empty" },
  { name: "true shorthand", input: true, expectedErrorFragment: "Expected false, a command string" },
  {
    name: "shell test normalizes without materializing the planner's 10/5/5 defaults",
    input: { test: "curl -f localhost" },
    expected: { kind: "command", command: "curl -f localhost" },
  },
  {
    name: "CMD test preserves direct argv",
    input: { test: ["CMD", "curl", "-f", "localhost"] },
    expected: { kind: "command", command: ["curl", "-f", "localhost"] },
  },
  {
    name: "CMD-SHELL test preserves a string command without pre-wrapping sh -c",
    input: { test: ["CMD-SHELL", "echo ready"] },
    expected: { kind: "command", command: "echo ready" },
  },
  { name: "NONE test disables the probe", input: { test: ["NONE"], interval: "5s" }, expected: false },
  { name: "empty test array is rejected", input: { test: [] }, expectedErrorFragment: "CMD" },
  {
    name: "NONE test rejects extra arguments",
    input: { test: ["NONE", "x"] },
    expectedErrorFragment: "NONE",
  },
  { name: "CMD test requires argv", input: { test: ["CMD"] }, expectedErrorFragment: "CMD" },
  {
    name: "CMD-SHELL test requires a command",
    input: { test: ["CMD-SHELL"] },
    expectedErrorFragment: "CMD-SHELL",
  },
  {
    name: "CMD-SHELL test rejects extra arguments",
    input: { test: ["CMD-SHELL", "a", "b"] },
    expectedErrorFragment: "CMD-SHELL",
  },
  {
    name: "unknown test marker is rejected",
    input: { test: ["FOO", "x"] },
    expectedErrorFragment: "CMD-SHELL",
  },
  {
    name: "Compose durations normalize to fractional seconds",
    input: { test: ["CMD", "true"], interval: "500ms", timeout: "1m30s", start_period: "1h2m3s" },
    expected: {
      kind: "command",
      command: ["true"],
      intervalSeconds: 0.5,
      timeoutSeconds: 90,
      startPeriodSeconds: 3723,
    },
  },
  {
    name: "invalid interval is rejected with duration remediation",
    input: { interval: "5x" },
    expectedErrorFragment: "30s",
  },
  {
    name: "invalid timeout is rejected with duration remediation",
    input: { timeout: "30 seconds" },
    expectedErrorFragment: "30s",
  },
  {
    name: "invalid start_period is rejected with duration remediation",
    input: { start_period: "-5s" },
    expectedErrorFragment: "30s",
  },
  {
    name: "start_interval stays a raw string without startIntervalSeconds",
    input: { start_interval: "5s" },
    expected: { startInterval: "5s" },
  },
  {
    name: "none validates and discards shared and Compose fields",
    input: {
      test: ["CMD", "x"],
      disable: false,
      interval: "5s",
      kind: "none",
      retries: "3",
      start_interval: "5s",
    },
    expected: false,
  },
  {
    name: "command selects Lando precedence over disable",
    input: { command: ["true"], disable: true },
    expected: { kind: "command", command: ["true"] },
  },
  {
    name: "url selects Lando precedence",
    input: { ...ignoredComposeKeys, url: "http://localhost/health" },
    expected: { url: "http://localhost/health" },
  },
  {
    name: "port selects Lando precedence",
    input: { ...ignoredComposeKeys, port: 8080 },
    expected: { port: 8080 },
  },
  {
    name: "intervalSeconds selects Lando precedence over interval",
    input: { intervalSeconds: 7, interval: "30s" },
    expected: { intervalSeconds: 7 },
  },
  {
    name: "timeoutSeconds selects Lando precedence",
    input: { ...ignoredComposeKeys, timeoutSeconds: 8 },
    expected: { timeoutSeconds: 8 },
  },
  {
    name: "startPeriodSeconds selects Lando precedence",
    input: { ...ignoredComposeKeys, startPeriodSeconds: 9 },
    expected: { startPeriodSeconds: 9 },
  },
  { name: "boolean true disables the check", input: { disable: true }, expected: false },
  { name: "string true disables the check", input: { disable: "true" }, expected: false },
  { name: "uppercase TRUE disables the check", input: { disable: "TRUE" }, expected: false },
  { name: "trimmed true disables the check", input: { disable: " true " }, expected: false },
  { name: "boolean false has no effect", input: { disable: false }, expected: {} },
  { name: "string false has no effect", input: { disable: "false" }, expected: {} },
  {
    name: "unsupported disable string is rejected",
    input: { disable: "yes" },
    expectedErrorFragment: '"true" or "false"',
  },
  { name: "numeric retries is preserved", input: { retries: 3 }, expected: { retries: 3 } },
  { name: "decimal-integer retries is parsed", input: { retries: "3" }, expected: { retries: 3 } },
  { name: "fractional retries is rejected", input: { retries: "3.5" }, expectedErrorFragment: "retries" },
  { name: "negative retries is rejected", input: { retries: "-1" }, expectedErrorFragment: "retries" },
  { name: "hex retries is rejected", input: { retries: "0x10" }, expectedErrorFragment: "retries" },
  { name: "whitespace retries is rejected", input: { retries: " 3 " }, expectedErrorFragment: "retries" },
  { name: "exponent retries is rejected", input: { retries: "1e3" }, expectedErrorFragment: "retries" },
  { name: "empty retries is rejected", input: { retries: "" }, expectedErrorFragment: "retries" },
] as const satisfies ReadonlyArray<AcceptedFixture | RejectedFixture>;

const acceptedFixtures = composeHealthcheckFixtures.filter((fixture) => "expected" in fixture);
const rejectedFixtures = composeHealthcheckFixtures.filter((fixture) => "expectedErrorFragment" in fixture);

describe("HealthcheckInput", () => {
  test.each([
    { disable: true, retries: "bad" },
    { disable: true, interval: "bad" },
    { disable: true, timeout: "bad" },
    { disable: true, start_period: "bad" },
    { disable: true, start_interval: "bad" },
    { disable: true, test: ["CMD"] },
    { kind: "none", retries: "bad" },
    { kind: "none", disable: "yes" },
    { kind: "none", interval: "bad" },
    { kind: "none", command: [] },
    { kind: "none", command: "" },
    { test: ["NONE"], retries: "bad" },
    { test: ["NONE"], timeout: "bad" },
  ])("rejects malformed siblings before disabling: %j", (input) => {
    const result = Schema.decodeUnknownResult(HealthcheckInput)(input, { onExcessProperty: "error" });
    expect(Result.isFailure(result)).toBe(true);
  });
  test.each(acceptedFixtures)("normalizes and wires ServiceConfig: $name", ({ input, expected }) => {
    // Given / When
    const decoded = [
      Schema.decodeUnknownSync(HealthcheckInput)(input),
      Schema.decodeUnknownSync(HealthcheckInput)(input, { onExcessProperty: "error" }),
      Schema.decodeUnknownSync(ServiceConfig)({ healthcheck: input }).healthcheck,
      Schema.decodeUnknownSync(ServiceConfig)({ healthcheck: input }, { onExcessProperty: "error" })
        .healthcheck,
    ];

    // Then
    for (const value of decoded) expect(value).toEqual(expected);
  });

  test.each(rejectedFixtures)("rejects through the field and ServiceConfig: $name", (fixture) => {
    // Given / When
    const results: readonly Result.Result<unknown, Schema.SchemaError>[] = [
      Schema.decodeUnknownResult(HealthcheckInput)(fixture.input),
      Schema.decodeUnknownResult(HealthcheckInput)(fixture.input, { onExcessProperty: "error" }),
      Schema.decodeUnknownResult(ServiceConfig)({ healthcheck: fixture.input }),
      Schema.decodeUnknownResult(ServiceConfig)(
        { healthcheck: fixture.input },
        { onExcessProperty: "error" },
      ),
    ];

    // Then
    for (const result of results) {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(String(result.failure)).toContain(fixture.expectedErrorFragment);
    }
  });

  test.each(acceptedFixtures)("is idempotent and encode-lawful: $name", ({ input }) => {
    // Given
    const defaultDecoded = Schema.decodeUnknownSync(HealthcheckInput)(input);
    const strictDecoded = Schema.decodeUnknownSync(HealthcheckInput)(input, { onExcessProperty: "error" });

    // When
    const defaultDecodedAgain = Schema.decodeUnknownSync(HealthcheckInput)(defaultDecoded);
    const strictDecodedAgain = Schema.decodeUnknownSync(HealthcheckInput)(strictDecoded, {
      onExcessProperty: "error",
    });
    const encoded = Schema.encodeSync(HealthcheckInput)(defaultDecoded);

    // Then
    expect(defaultDecodedAgain).toEqual(defaultDecoded);
    expect(strictDecodedAgain).toEqual(strictDecoded);
    expect(Schema.decodeUnknownSync(HealthcheckInput)(encoded)).toEqual(defaultDecoded);
  });

  test("encodes canonical Lando keys and raw start_interval only", () => {
    const canonical = {
      kind: "command",
      command: ["true"],
      url: "http://localhost/health",
      port: 8080,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
      startPeriodSeconds: 2,
      startInterval: "5s",
    } as const satisfies typeof HealthcheckInput.Type;

    const encoded = Schema.encodeSync(HealthcheckInput)(canonical);

    expect(encoded).toEqual({
      kind: "command",
      command: ["true"],
      url: "http://localhost/health",
      port: 8080,
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
      startPeriodSeconds: 2,
      start_interval: "5s",
    });
    expect(Schema.encodeSync(ServiceConfig)({ healthcheck: canonical })).toEqual({ healthcheck: encoded });
  });

  test.each([
    {
      field: "test marker",
      attackerValue: `marker-${"x".repeat(4_096)}`,
      input: { test: [`marker-${"x".repeat(4_096)}`] },
    },
    {
      field: "disable",
      attackerValue: `disable-${"x".repeat(4_096)}`,
      input: { disable: `disable-${"x".repeat(4_096)}` },
    },
    {
      field: "retries",
      attackerValue: `retries-${"x".repeat(4_096)}`,
      input: { retries: `retries-${"x".repeat(4_096)}` },
    },
  ])("bounds $field validation messages through ServiceConfig", ({ attackerValue, input }) => {
    // Given / When
    const result = Schema.decodeUnknownResult(ServiceConfig)({ healthcheck: input });

    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    const message = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.find(
      ({ message }) => message.startsWith("Landofile service"),
    )?.message;
    expect(message).toBeDefined();
    if (message === undefined) return;
    expect(message.length).toBeLessThan(1_024);
    expect(message).not.toContain(attackerValue);
  });
});

describe("public healthcheck contracts", () => {
  test("HealthcheckInput is the ServiceConfig authoring codec with canonical output", () => {
    const value = {
      kind: "http",
      command: "curl localhost",
      url: "http://localhost/health",
      port: 8080,
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 3,
      startPeriodSeconds: 2,
    } as const;
    expect(Schema.decodeUnknownSync(HealthcheckInput)(value)).toEqual(value);
    expect(ServiceConfig.fields.healthcheck.schema).toBe(HealthcheckInput);
  });

  test("ServiceConfig stays a Struct and encodes a healthcheck-bearing value lawfully", () => {
    expect(AST.isObjects(ServiceConfig.ast)).toBe(true);
    if (!AST.isObjects(ServiceConfig.ast)) return;
    const propertyNames = ServiceConfig.ast.propertySignatures.map(({ name }) => String(name));
    const decoded = Schema.decodeUnknownSync(ServiceConfig)({
      healthcheck: { test: ["NONE"], start_interval: "5s" },
    });

    const encoded = Schema.encodeSync(ServiceConfig)(decoded);

    expect(propertyNames).toContain("healthcheck");
    expect(Schema.decodeUnknownSync(ServiceConfig)(encoded)).toEqual(decoded);
  });
});
