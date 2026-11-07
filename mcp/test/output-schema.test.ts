import { expect, test } from "bun:test";
import { AppConfigResultSchema } from "@lando/engine/operations/app-config-result";
import { type CommandResultOutcome, encodeCommandResult } from "@lando/sdk/command-result";
import {
  LandofileValidationError,
  McpToolInputError,
  McpToolNotAllowedError,
  McpTransportError,
} from "@lando/sdk/errors";
import {
  DeprecationUse,
  ExecAppResult,
  InfoAppResult,
  ServiceInfo,
  StartAppResult,
  getJsonSchemaWithDeprecations,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { compactOutputSchema } from "../src/output-schema";
import { rejectionResult, toolOutputSchema } from "../src/tool-result";
import { conforms } from "./schema-conformance";

test.each([
  new McpToolInputError({
    toolId: "app:info",
    path: "appPath",
    message: "Invalid private-path",
    remediation: "Choose an app.",
  }),
  new McpToolNotAllowedError({
    toolId: "app:info",
    effectiveAllowlist: [],
    source: "defaults",
    message: "Denied private-path",
    remediation: "Allow the tool.",
  }),
  new McpTransportError({ message: "Transport private-path", remediation: "Retry the call." }),
])("returns schema-valid structured rejection for $_tag", async (error) => {
  const result = await Effect.runPromise(
    rejectionResult(error, {
      toolId: "app:info",
      redactor: createRedactor("secrets", { values: ["private-path"] }),
    }),
  );
  const envelope = Schema.decodeUnknownSync(Schema.JsonObject)(result.structuredContent);
  expect(conforms(toolOutputSchema(InfoAppResult), envelope)).toBe(true);
  expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null")).toEqual(envelope);
  expect(JSON.stringify(result)).not.toContain("private-path");
  expect(result.isError).toBe(true);
  expect(envelope).toMatchObject({
    apiVersion: "v4",
    command: "app:info",
    ok: false,
    error: {
      _tag: error._tag,
      message: expect.stringContaining("[redacted]"),
      remediation: error.remediation,
    },
    warnings: [],
    deprecations: [],
  });
});

const fixtures: readonly {
  readonly command: string;
  readonly schema: Schema.Codec<unknown, unknown>;
  readonly value: Schema.JsonObject;
}[] = [
  {
    command: "app:info",
    schema: InfoAppResult,
    value: {
      app: "demo",
      services: [
        {
          app: "demo",
          service: "web",
          api: 4,
          type: "nginx",
          provider: "test",
          primary: true,
          status: "running",
          connections: [],
        },
      ],
    },
  },
  {
    command: "app:start",
    schema: StartAppResult,
    value: { app: "demo", servicesStarted: [{ name: "web", state: "running", connections: [] }], checks: [] },
  },
  {
    command: "app:config:get",
    schema: AppConfigResultSchema,
    value: { source: "resolved", subcommand: "get", key: "services", value: { web: { type: "nginx" } } },
  },
  {
    command: "app:exec",
    schema: ExecAppResult,
    value: { app: "demo", service: "web", command: ["false"], exitCode: 1, stdout: "", stderr: "failed" },
  },
];

test.each(fixtures)(
  "accepts real success, failure, partial and truncated envelopes for $command",
  async ({ command, schema, value }) => {
    // Given
    const error = new LandofileValidationError({
      file: ".lando.yml",
      message: "Invalid service",
      remediation: "Fix the service",
      issues: [
        { path: ["services", "web", "ports", 0], message: "Invalid port", suggestion: "Use an integer" },
      ],
    });
    const outcomes: readonly CommandResultOutcome[] = [
      { _tag: "success", value },
      { _tag: "failure", error, additionalErrors: [] },
      { _tag: "failure", value, error, additionalErrors: [] },
    ];
    const projected = toolOutputSchema(schema);
    // When
    const envelopes = await Effect.runPromise(
      Effect.all(
        outcomes.map((outcome) =>
          encodeCommandResult({
            command,
            resultSchema: schema,
            outcome,
            redactor: createRedactor("secrets"),
            output: { chunks: [{ _tag: "stdout", chunk: "tail", service: "web" }], truncated: true },
            warnings: [{ code: "example", message: "Review the input", context: { service: "web" } }],
            deprecations: [
              Schema.decodeUnknownSync(DeprecationUse)({
                kind: "flag",
                id: "example",
                notice: { since: "4.2.0", note: "Use the replacement", severity: "warn" },
                timestamp: "2026-10-30T00:00:00.000Z",
              }),
            ],
          }).pipe(Effect.map((text) => Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(text)))),
        ),
      ),
    );
    // Then
    for (const [index, envelope] of envelopes.entries()) {
      expect(envelope.ok).toBe(index === 0);
      expect(envelope).not.toMatchObject({ error: { _tag: "CommandResultEncodeError" } });
      expect(conforms(projected, envelope)).toBe(true);
      expect(envelope).toMatchObject({ output: { truncated: true } });
    }
    expect(envelopes[2]?.result).toEqual(value);
    expect(Schema.decodeUnknownSync(Schema.JsonObject)(envelopes[1]?.error).issues).toEqual(error.issues);
  },
);

test("preserves result union shape and only names exact public subtrees", () => {
  // Given
  const projected = toolOutputSchema(StartAppResult);
  const union = toolOutputSchema(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("ready"), detail: Schema.Struct({ count: Schema.Number }) }),
      Schema.Struct({ kind: Schema.Literal("waiting"), reason: Schema.String }),
    ]),
  );
  // When / Then
  expect(projected).toMatchObject({
    properties: {
      result: {
        properties: {
          servicesStarted: {
            items: { type: "object", description: expect.stringContaining("lando://schemas/StartedService") },
          },
          checks: { items: { description: expect.stringContaining("lando://schemas/CheckResult") } },
        },
      },
    },
  });
  expect(union).toMatchObject({
    properties: {
      result: {
        anyOf: [
          {
            properties: { kind: { enum: ["ready"] }, detail: { type: "object" } },
            required: ["kind", "detail"],
          },
          {
            properties: { kind: { enum: ["waiting"] }, reason: { type: "string" } },
            required: ["kind", "reason"],
          },
        ],
      },
    },
  });
  expect(JSON.stringify(toolOutputSchema(InfoAppResult))).toContain("lando://schemas/ServiceInfo");
  const projectedJson = JSON.stringify(projected);
  expect(projectedJson).not.toContain('"trace"');
  expect(projectedJson).not.toContain('"$ref"');
  expect(projectedJson).not.toContain('"additionalProperties":false');
  const custom = toolOutputSchema(
    Schema.Struct({
      services: Schema.Array(Schema.Struct({ ...ServiceInfo.fields, custom: Schema.String })),
    }),
  );
  expect(JSON.stringify(custom)).not.toContain("lando://schemas/ServiceInfo");
});

test("widens recursive references and preserves nested union discriminants", () => {
  // Given
  const schema: Schema.JsonObject = {
    type: "object",
    properties: {
      result: {
        type: "object",
        properties: {
          detail: {
            anyOf: [
              {
                type: "object",
                properties: { kind: { enum: ["node"] }, child: { $ref: "#/$defs/Node" } },
                required: ["kind"],
              },
              { type: "null" },
            ],
          },
        },
        required: ["detail"],
      },
    },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
  };
  // When
  const compact = compactOutputSchema(schema);
  // Then
  expect(conforms(compact, { result: { detail: { kind: "node", child: { child: { child: 3 } } } } })).toBe(
    true,
  );
  expect(conforms(compact, { result: { detail: { kind: "other" } } })).toBe(false);
  expect(conforms(compact, { result: { detail: null } })).toBe(true);
  expect(JSON.stringify(compact)).not.toContain('"$ref"');
});

test("widens overlapping exclusive unions without rejecting valid variants", () => {
  // Given
  const full = Schema.decodeUnknownSync(Schema.JsonObject)(
    getJsonSchemaWithDeprecations(Schema.Struct({ result: Schema.Unknown })),
  );
  const schema: Schema.JsonObject = {
    ...full,
    properties: {
      result: {
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
        ],
      },
    },
  };
  // When
  const compact = compactOutputSchema(schema);
  // Then
  expect(conforms(compact, { result: { a: "a", b: "b" } })).toBe(true);
  expect(conforms(compact, { result: { a: 3 } })).toBe(false);
});
