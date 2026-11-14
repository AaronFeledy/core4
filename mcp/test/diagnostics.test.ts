import { expect, test } from "bun:test";
import type { McpAppGeneration, McpGenerationCommand } from "@lando/mcp/apps";
import { makeMcpAllowPolicy } from "@lando/mcp/catalog";
import { type McpDiagnostic, McpService, boundDiagnostics, pluginDiagnostics } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { Context, Effect, Fiber, Schema } from "effect";
import { serverLayer } from "./server";

const failed = (id: string, source: "bundled" | "external", mcpAllowed = true) =>
  ({
    _tag: "Failed",
    commandId: id,
    error: new SyntaxError("invalid module"),
    owner: { spec: { id, mcpAllowed }, plugin: { name: `owner-${id}`, source } },
    diagnostic: {
      _tag: "PluginLoadError",
      message: `Cannot load ${id}`,
      remediation: "Repair the module and retry.",
    },
  }) satisfies McpGenerationCommand;

test.each([
  { source: "bundled" as const, reviewed: true, allow: [], deny: [], visible: true },
  { source: "bundled" as const, reviewed: false, allow: [], deny: [], visible: false },
  { source: "external" as const, reviewed: true, allow: [], deny: [], visible: false },
  { source: "external" as const, reviewed: false, allow: ["db:snapshots"], deny: [], visible: true },
  {
    source: "bundled" as const,
    reviewed: true,
    allow: ["db:snapshots"],
    deny: ["db:snapshots"],
    visible: false,
  },
])(
  "failed $source owner disclosure requires reviewed defaults or explicit authorization %#",
  ({ source, reviewed, allow, deny, visible }) => {
    const generation: McpAppGeneration = {
      key: "/app",
      context: Context.makeUnsafe<unknown>(new Map()),
      commands: new Map([["db:snapshots", failed("db:snapshots", source, reviewed)]]),
    };
    const diagnostics = pluginDiagnostics(
      generation,
      makeMcpAllowPolicy({ defaults: ["db:snapshots"], allow, deny }),
    );
    expect(diagnostics.map((record) => record.commandId)).toEqual(visible ? ["db:snapshots"] : []);
  },
);

test("omission accounting excludes denied, hidden, unowned, and never-allowed failures", () => {
  const hidden = failed("fixture:hidden", "bundled");
  const commands = new Map<string, McpGenerationCommand>([
    ["fixture:denied", failed("fixture:denied", "external")],
    ["app:remote:tether", failed("app:remote:tether", "bundled")],
    [
      "fixture:hidden",
      { ...hidden, owner: { ...hidden.owner, spec: { ...hidden.owner.spec, hidden: true } } },
    ],
    ["fixture:unowned", { _tag: "Failed", commandId: "fixture:unowned", error: new SyntaxError("private") }],
  ]);
  const policy = makeMcpAllowPolicy({
    defaults: [...commands.keys()],
    allow: [...commands.keys()],
    deny: ["fixture:denied"],
  });
  const result = boundDiagnostics(
    7,
    pluginDiagnostics({ key: "/app", context: Context.makeUnsafe<unknown>(new Map()), commands }, policy),
    createStandaloneRedactor("secrets"),
  );
  expect(result).toEqual({ revision: 7, diagnostics: [], omittedDiagnosticCount: 0 });
});

test("diagnostics redact before the total UTF-8 bound and omit whole locations with accurate accounting", () => {
  const secret = "sensitive-value-".repeat(2000);
  const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: [secret] });
  const records: readonly McpDiagnostic[] = [
    { commandId: "app:redacted", kind: "tooling", _tag: "ToolingCompileError", message: secret },
    {
      commandId: "app:oversized",
      kind: "tooling",
      _tag: "ToolingCompileError",
      message: "Invalid input",
      issues: [
        {
          path: ["tooling", "oversized", "\u754c".repeat(6000)],
          message: "Invalid location",
          reason: "invalid-declaration",
        },
      ],
    },
    { commandId: "app:small", kind: "tooling", _tag: "ToolingCompileError", message: "Invalid flag" },
  ];
  const result = boundDiagnostics(3, records, redactor);
  expect(result).toEqual({
    revision: 3,
    diagnostics: [
      { commandId: "app:redacted", kind: "tooling", _tag: "ToolingCompileError", message: "[redacted]" },
      { commandId: "app:small", kind: "tooling", _tag: "ToolingCompileError", message: "Invalid flag" },
    ],
    omittedDiagnosticCount: 1,
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("removing a tooling task does not grant its implicit allowance to a selected external plugin", async () => {
  const spec = {
    id: "fixture:replaced",
    summary: "Current owner",
    resultSchema: Schema.String,
    run: () => Effect.succeed("tooling"),
  };
  const generation: McpAppGeneration = {
    key: process.cwd(),
    context: Context.makeUnsafe<unknown>(new Map()),
    commands: new Map([
      [
        spec.id,
        {
          _tag: "Eligible",
          entry: {
            spec: { ...spec, run: () => Effect.succeed("external") },
            plugin: { name: "replacement", source: "external" },
          },
        },
      ],
    ]),
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", tooling: true }));
        const before = yield* client.request("tools/list");
        expect(before.result).toMatchObject({ tools: [expect.objectContaining({ name: spec.id })] });
        yield* client.request("resources/read", { uri: "lando://diagnostics" });
        expect((yield* client.request("tools/list")).result).toMatchObject({ tools: [] });
        expect(yield* client.request("tools/call", { name: spec.id, arguments: {} })).toHaveProperty("error");
        yield* client.close;
        yield* Fiber.join(client.fiber);
      }).pipe(
        Effect.provide(
          serverLayer({
            toolingEntries: [{ spec, tooling: true }],
            apps: Effect.succeed({ acquire: () => Effect.succeed(generation) }),
            toolingCatalog: () => Effect.succeed({ revision: "removed", entries: [], unavailable: [] }),
          }),
        ),
      ),
    ),
  );
});
