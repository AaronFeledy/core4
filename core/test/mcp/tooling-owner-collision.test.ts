import { expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient, testAppGenerations } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import { Effect, Layer, Result, Schema } from "effect";
import { buildMcpListResult } from "../../src/cli/commands/meta/mcp-list";
import { serviceLayer } from "../../src/mcp-command-executor";

test("catalog, CLI list, stdio list and call select tooling over the built-in app:info owner", async () => {
  const resultSchema = Schema.Struct({ owner: Schema.String });
  const commandEntries = [
    {
      kind: "command" as const,
      spec: {
        id: "app:info",
        summary: "Built-in info",
        resultSchema,
        run: () => Effect.succeed({ owner: "built-in" }),
      },
    },
  ];
  const toolingEntries = [
    {
      kind: "tooling" as const,
      spec: {
        id: "app:info",
        summary: "Landofile info task",
        toolingInput: Result.getOrThrow(
          normalizeToolingInput("info", { flags: { loud: { boolean: true } } }),
        ),
        resultSchema,
        run: () => Effect.succeed({ owner: "tooling" }),
      },
    },
  ];
  const config = {
    cwd: process.cwd(),
    env: {},
    commandEntries,
    toolingEntries,
    defaultAllowlist: ["app:info"],
    apps: testAppGenerations(),
  };
  const layer = serviceLayer.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(McpRuntimeConfig, config), RedactionService.layer)),
  );

  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const catalog = yield* service.catalog({ tooling: true });
        const client = yield* startStdioClient(service.serve({ transport: "stdio", tooling: true }));
        const listing = yield* client.request("tools/list");
        const call = yield* client.request("tools/call", {
          name: "app:info",
          arguments: { flags: { loud: true } },
        });
        return { catalog, listing, call };
      }),
    ).pipe(Effect.provide(layer)),
  );
  const cli = buildMcpListResult({ ...config, tooling: true });
  const catalog = buildCatalog({
    ...config,
    options: { tooling: true },
    effective: computeEffectiveAllowlist({ defaults: config.defaultAllowlist }),
  });

  for (const projection of [observed.catalog, catalog]) {
    expect(projection.tools.map((tool) => [tool.toolId, tool.title])).toEqual([
      ["app:info", "Landofile info task"],
    ]);
    expect(projection.tools[0]?.inputSchema).toMatchObject({
      properties: { flags: { properties: { loud: { type: "boolean" } } } },
    });
  }
  expect(cli.tools).toEqual([{ id: "app:info", summary: "Landofile info task", source: "default+tooling" }]);
  expect(observed.listing.result).toMatchObject({
    tools: [
      {
        name: "app:info",
        description: "Landofile info task",
        inputSchema: { properties: { flags: { properties: { loud: { type: "boolean" } } } } },
      },
    ],
  });
  const listing = Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Unknown) }))(
    observed.listing.result,
  );
  expect(listing.tools).toHaveLength(1);
  expect(observed.call.result).toMatchObject({
    structuredContent: { ok: true, result: { owner: "tooling" } },
  });
});
