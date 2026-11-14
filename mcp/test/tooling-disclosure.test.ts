import { expect, test } from "bun:test";
import { dispatchTool } from "@lando/mcp/dispatch";
import { type McpDiagnostic, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { createStandaloneRedactor, makeRedactionService } from "@lando/redaction/service";
import { ToolingCompileError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Context, Effect, Schema } from "effect";
import { serverLayer } from "./server";

const error = new ToolingCompileError({
  tool: "run",
  source: { path: `/app/${"xy".repeat(2000)}.yml`, task: "run" },
  message: "Invalid xy ".repeat(200),
  remediation: "Correct xy ".repeat(200),
  omittedIssueCount: 3,
  issues: Array.from({ length: 10 }, (_, index) => ({
    path: ["tooling", "run", index],
    message: "xy ".repeat(300),
    source: { layer: "canonical" as const, file: "/app/whole.yml", path: ["tooling", "run", index] },
  })),
});
const expanded = createStandaloneRedactor("secrets", { authoritativeTokens: ["xy"] });

test("MCP tool error results use the result redactor when bounding tooling findings", async () => {
  const entry = {
    kind: "command" as const,
    spec: { id: "app:run", summary: "Run", resultSchema: Schema.Void, run: () => Effect.fail(error) },
  };
  const result = await Effect.runPromise(
    dispatchTool(
      { toolId: entry.spec.id },
      {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "defaults",
        redactor: createStandaloneRedactor("secrets"),
        resultRedactor: () => Effect.succeed(expanded),
        execute: () => Effect.succeed({ _tag: "failure", error, additionalErrors: [] }),
        publish: () => Effect.void,
      },
    ),
  );
  const diagnostic = Schema.decodeUnknownSync(CommandResultEnvelope)(result.envelope).error;
  expect(result.ok).toBe(false);
  expect(diagnostic?._tag).toBe("ToolingCompileError");
  expect(diagnostic?.issues?.map((issue) => issue.path.at(-1))).toEqual([0, 1, 2, 3]);
  expect(diagnostic?.omittedIssueCount).toBe(9);
  expect(diagnostic).not.toHaveProperty("source");
  expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(diagnostic?.message ?? "")).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(diagnostic?.remediation ?? "")).toBeLessThanOrEqual(1024);
  expect(JSON.stringify(diagnostic)).not.toContain("xy");
});

test("diagnostics reads bound with the read redactor after authorization and count authorized omissions", async () => {
  const records: McpDiagnostic[] = [
    ...["app:run", "app:denied"].map(
      (commandId): McpDiagnostic => ({
        _tag: "ToolingCompileError",
        commandId,
        kind: "tooling",
        message: error.message,
        remediation: error.remediation,
        ...(error.source === undefined ? {} : { source: error.source }),
        issues: error.issues,
        omittedIssueCount: error.omittedIssueCount,
      }),
    ),
    { commandId: "app:huge", kind: "tooling", _tag: "OtherError", message: "xy".repeat(3000) },
  ];
  let reading = false;
  const baseRedactor = createStandaloneRedactor("secrets");
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(
          service.serve({ transport: "stdio", tooling: true, deny: ["app:denied"] }),
        );
        yield* Effect.sync(() => {
          reading = true;
        });
        return yield* client.request("resources/read", { uri: "lando://diagnostics" });
      }),
    ).pipe(
      Effect.provide(
        serverLayer(
          {
            toolingUnavailable: records,
            apps: Effect.succeed({
              acquire: () =>
                Effect.succeed({
                  key: process.cwd(),
                  context: Context.makeUnsafe<unknown>(new Map()),
                  commands: new Map(),
                }),
            }),
          },
          [],
          { ...makeRedactionService(), forProfile: () => Effect.succeed(reading ? expanded : baseRedactor) },
        ),
      ),
    ),
  );
  const resource = Schema.decodeUnknownSync(
    Schema.Struct({ contents: Schema.Array(Schema.Struct({ text: Schema.String })) }),
  )(response.result);
  const text = resource.contents[0]?.text ?? "null";
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  const payload = Schema.decodeUnknownSync(
    Schema.Struct({
      diagnostics: Schema.Array(
        Schema.Struct({
          commandId: Schema.String,
          issues: Schema.Array(Schema.Unknown),
          omittedIssueCount: Schema.Number,
          message: Schema.String,
          remediation: Schema.String,
        }),
      ),
      omittedDiagnosticCount: Schema.Number,
    }),
  )(JSON.parse(text));
  expect(payload.diagnostics.map((record) => record.commandId)).toEqual(["app:run"]);
  expect(payload.omittedDiagnosticCount).toBe(1);
  expect(payload.diagnostics[0]?.issues).toHaveLength(4);
  expect(payload.diagnostics[0]?.omittedIssueCount).toBe(9);
  expect(Buffer.byteLength(payload.diagnostics[0]?.message ?? "")).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(payload.diagnostics[0]?.remediation ?? "")).toBeLessThanOrEqual(1024);
  expect(text).not.toContain("xy");
  expect(text).not.toContain("app:denied");
  expect(text.match(/\/app\/whole\.yml/gu)).toHaveLength(4);
});
