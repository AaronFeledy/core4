import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { makeAppGenerations } from "@lando/engine/runtime/app-generations";
import type { OperationDiscovery } from "@lando/landofile/operation-discovery";
import type { McpAppGeneration, McpAppGenerationFailure, McpAppGenerationsShape } from "@lando/mcp/apps";
import { RedactionService } from "@lando/redaction/service";
import { Context, Effect, type Scope } from "effect";

import type {
  AppGenerationServices,
  GenerationHostServices,
  LandoGenerationRuntime,
} from "../../../runtime/layer";
import type { PluginCommandDiagnostic } from "../../plugin-command-catalog";
import { projectMcpPluginCommands, retryFailedMcpPluginCommands } from "./mcp-plugins";

export interface McpAppGenerationRecord extends McpAppGeneration {
  readonly diagnostics: ReadonlyArray<PluginCommandDiagnostic>;
}

export interface McpAppGenerations extends McpAppGenerationsShape {
  readonly acquire: (
    cwd: string,
  ) => Effect.Effect<McpAppGenerationRecord, McpAppGenerationFailure, Scope.Scope | OperationDiscovery>;
}

export const makeMcpAppGenerations = Effect.fnUntraced(function* (input: {
  readonly runtime: LandoGenerationRuntime;
  readonly host: Context.Context<GenerationHostServices>;
  readonly sessionIds: ReadonlySet<string>;
}) {
  const redaction = Context.get(input.host, RedactionService);
  return yield* makeAppGenerations<
    GenerationHostServices,
    AppGenerationServices,
    McpAppGenerationRecord,
    McpAppGenerationFailure
  >({
    policy: input.runtime.pluginPolicy,
    host: input.host,
    build: input.runtime.generation,
    project: Effect.fnUntraced(function* ({ key, context }) {
      const graph = Context.get(context, PluginContributionGraph);
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const projection = yield* projectMcpPluginCommands(graph, input.sessionIds, redactor);
      return {
        key,
        context: Context.makeUnsafe<unknown>(context.mapUnsafe),
        commands: projection.commands,
        diagnostics: projection.diagnostics,
      } satisfies McpAppGenerationRecord;
    }),
    refresh: Effect.fnUntraced(function* (record: McpAppGenerationRecord) {
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const commands = yield* retryFailedMcpPluginCommands(
        Context.get(record.context, PluginContributionGraph),
        record.commands,
        redactor,
      );
      return commands === undefined
        ? record
        : {
            ...record,
            commands,
            diagnostics: [...commands.values()].flatMap((command) =>
              command._tag === "Failed"
                ? command.diagnostic === undefined
                  ? []
                  : [command.diagnostic]
                : (command.diagnostics ?? []),
            ),
          };
    }),
  });
});
