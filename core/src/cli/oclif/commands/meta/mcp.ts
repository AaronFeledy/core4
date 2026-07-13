import { Flags } from "@oclif/core";
import { Effect, Layer } from "effect";

import { LandoRuntimeBootstrapError, NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";

import type { RedactionService } from "../../../../redaction/service.ts";

import { cliRuntimeOptions } from "../../../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../../../runtime/layer.ts";
import type { RendererMode } from "../../../bug-report.ts";
import {
  type McpListResult,
  McpListResultSchema,
  renderMcpListResult,
} from "../../../commands/meta/mcp-list.ts";
import {
  dispatchMcpCommand,
  mcpFlagsFromParsed,
  mcpRegistryFromCompiled,
} from "../../../commands/meta/mcp.ts";
import { type ResultFormat, resolveResultFormat } from "../../../format-flags.ts";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "../../../renderer-boundary.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  formatCommandError,
  resolveTopLevelAliases,
} from "../../command-base.ts";
import { getCommandRuntimeLayer } from "../../hooks/init.ts";

const formatRendererSelectionError = (error: unknown): string =>
  formatCommandError({ error, commandId: "cli:renderer-selection", rendererMode: "plain" });

export const metaMcpSpec: LandoCommandSpec<McpListResult> = {
  resultSchema: McpListResultSchema,
  id: "meta:mcp",
  summary: "Serve the Model Context Protocol over stdio, or --list the effective tool catalog.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: () => Effect.succeed({ tools: [] }),
  render: (result, _input, ctx) => renderMcpListResult(result as McpListResult, ctx),
};

export default class MetaMcpCommand extends LandoCommandBase {
  static override description = metaMcpSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaMcpSpec)];
  static override flags = {
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
  };
  static override landoSpec: LandoCommandSpec = metaMcpSpec;
  static override bootstrap = metaMcpSpec.bootstrap;

  override async run(): Promise<void> {
    const { default: compiled } = await import("../../compiled-commands.ts");
    const registry = mcpRegistryFromCompiled(
      compiled as Record<string, { readonly landoSpec?: LandoCommandSpec }>,
    );

    let rendererMode: RendererMode;
    try {
      const resolution = await resolveCliRendererMode({
        argv: this.argv,
        env: process.env,
      });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        throw new Error(formatRendererSelectionError(error));
      }
      throw error;
    }

    const deprecationWarnings = resolveCliDeprecationWarnings({ argv: this.argv, env: process.env });
    this.argv.length = 0;
    this.argv.push(...deprecationWarnings.remainingArgv);

    let resultFormat: ResultFormat = "text";
    try {
      const resolution = resolveResultFormat({ argv: this.argv, rendererMode });
      resultFormat = resolution.format;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        throw new Error(formatRendererSelectionError(error));
      }
      throw error;
    }

    const parsed = await this.parse(MetaMcpCommand);
    const flags = mcpFlagsFromParsed((parsed as { flags?: Record<string, unknown> }).flags ?? {});
    const commandRuntime = getCommandRuntimeLayer(MetaMcpCommand);
    if (commandRuntime === undefined) {
      throw new LandoRuntimeBootstrapError({
        message: "OCLIF command meta:mcp is missing a valid static bootstrap declaration.",
        stage: "minimal",
      });
    }
    const retainedRuntime = makeLandoRuntime(
      cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }),
    ).pipe(Layer.orDie);

    await dispatchMcpCommand({
      registry,
      flags,
      commandRuntime: commandRuntime as Layer.Layer<
        ConfigService | RedactionService,
        LandoRuntimeBootstrapError
      >,
      retainedRuntime: retainedRuntime as Layer.Layer<unknown>,
      rendererMode,
      resultFormat,
      invocation: {
        commandId: metaMcpSpec.id,
        argv: this.argv,
        args: {},
        flags: Object.fromEntries(Object.entries(flags)),
        cwd: process.cwd(),
      },
      formatError: (error) => formatCommandError({ error, commandId: "meta:mcp", rendererMode }),
    });
  }
}
