import { expect, test } from "bun:test";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Layer, Schema } from "effect";
import { CommandConfirmationError } from "../../src/cli/require-confirmation";
import { serviceLayer } from "../../src/mcp-command-executor";
import { mcpRegistryWithPlugins } from "../../src/mcp-plugins";
import { pluginFixtureGraph } from "./plugin-fixture";

const fixture = () => {
  let executions = 0;
  // Like the SQL plugin, the command refuses without `yes` because its own prompt is non-interactive.
  const spec: ExecutableCommandSpec = {
    id: "fixture:reset",
    namespace: "fixture",
    bootstrap: "app",
    flags: { yes: { type: "boolean" } },
    resultSchema: Schema.Struct({ executions: Schema.Number }),
    run: (input) =>
      input.flags.yes === true
        ? Effect.sync(() => ({ executions: ++executions }))
        : Effect.fail(
            new CommandConfirmationError({
              reason: "non-interactive",
              message: "This command requires confirmation before changing the app.",
              remediation: "Re-run with --yes in non-interactive mode.",
            }),
          ),
  };
  const layer = Layer.unwrap(
    mcpRegistryWithPlugins({ commandEntries: [] }).pipe(
      Effect.provideService(PluginContributionGraph, pluginFixtureGraph(spec, { mcpAllowed: false })),
      Effect.map((registry) =>
        serviceLayer.pipe(
          Layer.provide(
            Layer.succeed(McpRuntimeConfig, {
              commandEntries: registry.commandEntries,
              defaultAllowlist: [],
              runtimeLayer: Layer.empty,
            }),
          ),
        ),
      ),
    ),
  ).pipe(Layer.provide(RedactionService.layer));
  return { spec, layer, executions: () => executions };
};

test.each([true, false])("plugin confirmation follows MCP elicitation (accepted=%s)", async (accepted) => {
  // Given an explicitly allowed plugin command that requires its own `yes`
  const host = fixture();
  // When the client answers the elicitation
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", allow: [host.spec.id] }), {
          elicitation: {},
        });
        const call = yield* client.sendRequest("tools/call", { name: host.spec.id });
        let reverse = yield* client.next;
        while (reverse.method !== "elicitation/create") reverse = yield* client.next;
        if (typeof reverse.id !== "string" && typeof reverse.id !== "number")
          throw new Error("Expected reverse request id");
        yield* client.send({
          jsonrpc: "2.0",
          id: reverse.id,
          result: accepted ? { action: "accept", content: { confirm: true } } : { action: "decline" },
        });
        return yield* call.response;
      }),
    ).pipe(Effect.provide(host.layer)),
  );
  // Then acceptance satisfies the plugin's confirmation and a decline never runs it
  expect(response).toMatchObject(
    accepted
      ? { result: { isError: false, structuredContent: { ok: true, result: { executions: 1 } } } }
      : {
          result: {
            isError: true,
            structuredContent: { ok: false, error: { _tag: "CommandConfirmationError", reason: "declined" } },
          },
        },
  );
  expect(host.executions()).toBe(accepted ? 1 : 0);
});
