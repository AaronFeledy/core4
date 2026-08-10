import { Effect, Layer } from "effect";
import { Flags } from "../../spec/metadata";

import { LandoRuntimeBootstrapError, NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";

import type { RedactionService } from "@lando/redaction/service";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { makeLandoRuntime } from "../../../runtime/layer";
import type { RendererMode } from "../../bug-report";
import { newInvocationId } from "../../command-lifecycle";
import { type McpCommandRegistry, dispatchMcpCommand, mcpFlagsFromParsed } from "../../commands/meta/mcp";
import { type McpListResult, McpListResultSchema, renderMcpListResult } from "../../commands/meta/mcp-list";
import { type ResultFormat, resolveResultFormat } from "../../format-flags";
import { resolveCliDeprecationWarnings, resolveCliRendererMode } from "../../renderer-boundary";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  formatCommandError,
  resolveTopLevelAliases,
} from "../../spec/command-base";
import {
  preCommandOutputMode,
  renderCommandFlagValueValidation,
  renderPreCommandFailure,
} from "../../spec/command-boundary";
import { getCommandRuntimeLayer } from "../../spec/hooks/init";

let mcpCommandRegistrySource: McpCommandRegistry = { commandEntries: [] };

export const injectMcpCommandRegistry = (registry: McpCommandRegistry): void => {
  mcpCommandRegistrySource = registry;
};

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
    const registry = mcpCommandRegistrySource;

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
        await renderPreCommandFailure({
          commandId: "cli:renderer-selection",
          error,
          ...preCommandOutputMode({ argv: this.argv, env: process.env }),
        });
        return;
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
        await renderPreCommandFailure({
          commandId: "cli:format-selection",
          error,
          rendererMode,
          resultFormat: rendererMode === "json" ? "json" : "text",
        });
        return;
      }
      throw error;
    }

    if (
      await renderCommandFlagValueValidation({
        commandId: metaMcpSpec.id,
        argv: this.argv,
        definitions: { ...this.ctor.baseFlags, ...this.ctor.flags },
        rendererMode,
        resultFormat,
        resultSchema: metaMcpSpec.resultSchema,
        deprecationWarnings: deprecationWarnings.enabled,
      })
    )
      return;

    const parsed = await this.parse(MetaMcpCommand);
    const flags = mcpFlagsFromParsed((parsed as { flags?: Record<string, unknown> }).flags ?? {});
    const commandRuntime = getCommandRuntimeLayer(MetaMcpCommand);
    if (commandRuntime === undefined) {
      await renderPreCommandFailure({
        commandId: metaMcpSpec.id,
        error: new LandoRuntimeBootstrapError({
          message: "Command meta:mcp is missing a valid static bootstrap declaration.",
          stage: "minimal",
        }),
        rendererMode,
        resultFormat,
        resultSchema: metaMcpSpec.resultSchema,
        deprecationWarnings: deprecationWarnings.enabled,
      });
      return;
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
        invocationId: newInvocationId(),
      },
      formatError: (error) => formatCommandError({ error, commandId: "meta:mcp", rendererMode }),
    });
  }
}
