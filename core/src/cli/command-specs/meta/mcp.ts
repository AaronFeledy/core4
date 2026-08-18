import { Effect } from "effect";
import { Flags } from "../../spec/metadata";

import type { ConfigService } from "@lando/sdk/services";
import { BuiltInCommandCatalog } from "../../built-in-command-catalog-service";
import { mcpFlagsFromParsed, mcpListResult, mcpRegistryFromBuiltIns } from "../../commands/meta/mcp";
import { type McpListResult, McpListResultSchema, renderMcpListResult } from "../../commands/meta/mcp-list";
import type { LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags } from "../../spec/command-boundary";

export const metaMcpSpec: LandoCommandSpec<McpListResult, unknown, BuiltInCommandCatalog | ConfigService> = {
  resultSchema: McpListResultSchema,
  id: "meta:mcp",
  summary: "Serve the Model Context Protocol over stdio, or --list the effective tool catalog.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  flags: {
    allow: Flags.string({
      multiple: true,
      description: "Allow a command id as an MCP tool; repeat to allow multiple commands.",
    }),
    deny: Flags.string({
      multiple: true,
      description: "Deny a command id from the effective MCP tool catalog; repeat to deny multiple commands.",
    }),
    tooling: Flags.boolean({
      description: "Include tooling-task MCP tools in the effective catalog.",
    }),
    list: Flags.boolean({
      description: "Print the effective MCP tool catalog instead of serving stdio MCP.",
    }),
  },
  run: (input) =>
    Effect.gen(function* () {
      const catalog = yield* BuiltInCommandCatalog;
      return yield* mcpListResult(
        mcpRegistryFromBuiltIns(catalog.entries),
        mcpFlagsFromParsed(extractSpecFlags(input)),
      );
    }),
  render: (result, _input, ctx) => renderMcpListResult(result as McpListResult, ctx),
};
