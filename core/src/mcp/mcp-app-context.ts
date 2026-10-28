import { Context, Effect, Layer, Option } from "effect";

import {
  AppPluginSourceRevision,
  PluginContributionGraph,
  appContributionGraphForCwd,
} from "@lando/engine/plugins/contribution-graph";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import * as CommandRegistryLayer from "@lando/engine/services/command-registry";
import { EventCommandExecutor } from "@lando/engine/services/event-command-executor";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { APP_COMMAND_TOOL_IDS } from "@lando/mcp/app-command-tools";
import type { McpRunInput } from "@lando/mcp/dispatch";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { AppPlanner, CommandRegistry, LandofileService, PluginRegistry } from "@lando/sdk/services";

import { builtInCommandEntries } from "../cli/built-in-command-registry";
import { commandAliasRegistrationError } from "../cli/command-alias-policy";
import * as EventCommandExecutorLayer from "../cli/event-command-executor";
import { validateEventCommandInput } from "../cli/event-command-input";
import { resolveEventCommandTarget } from "../cli/event-command-target";

/** Build only app-sensitive services for one retained MCP request. */
export const mcpAppContextForCwd = Effect.fn("Mcp.appContextForCwd")(function* (
  base: Context.Context<unknown>,
  cwd: string,
  options: { readonly app: boolean; readonly disable: ReadonlyArray<string> },
) {
  const graph = yield* withAppDiscovery(
    cwd,
    appContributionGraphForCwd(Context.get(base, PluginContributionGraph), cwd, options),
  ).pipe(Effect.provide(base));
  let context = Context.add(base, RuntimeCwd, cwd);
  context = Context.add(context, PluginContributionGraph, PluginContributionGraph.of(graph));
  if (graph.appPluginSourceRevision !== undefined) {
    context = Context.add(context, AppPluginSourceRevision, graph.appPluginSourceRevision);
  }
  const build = <A>(layer: Layer.Layer<A, unknown, unknown>) =>
    Layer.build(layer.pipe(Layer.provide(Layer.succeedContext(context))));
  if (Option.isNone(Context.getOption(graph.hostContext, PluginRegistry))) {
    context = Context.merge(context, yield* build(PluginRegistryLayer.layerWith()));
  }
  if (
    Option.isNone(Context.getOption(graph.hostContext, CommandRegistry)) &&
    Option.isSome(Context.getOption(context, LandofileService)) &&
    Option.isSome(Context.getOption(context, CommandRegistry))
  ) {
    context = Context.merge(
      context,
      yield* build(
        CommandRegistryLayer.layerWith((policy, entries) =>
          commandAliasRegistrationError(
            policy,
            entries.map((entry) => entry.id),
            entries,
          ),
        ),
      ),
    );
  }
  if (
    Option.isNone(Context.getOption(graph.hostContext, AppPlanner)) &&
    Option.isSome(Context.getOption(context, AppPlanner))
  ) {
    context = Context.merge(context, yield* build(AppPlannerLayer.layer));
  }
  if (
    Option.isNone(Context.getOption(graph.hostContext, EventCommandExecutor)) &&
    Option.isSome(Context.getOption(context, EventCommandExecutor))
  ) {
    context = Context.merge(context, yield* build(EventCommandExecutorLayer.layer));
  }
  return context;
});

export const mcpAppCommandEntries = Effect.fn("Mcp.appCommandEntries")(function* (
  context: Context.Context<unknown>,
) {
  const graph = Context.get(context, PluginContributionGraph);
  return yield* Effect.forEach(
    graph.commands.filter(
      (candidate) => !APP_COMMAND_TOOL_IDS.includes(candidate.id as (typeof APP_COMMAND_TOOL_IDS)[number]),
    ),
    (candidate) =>
      resolveEventCommandTarget(candidate.id, context, builtInCommandEntries).pipe(
        Effect.map((target): ReadonlyArray<McpCommandEntry> => {
          if (target.kind !== "plugin") return [];
          const spec = target.spec;
          let parsedInput: Parameters<typeof spec.run>[0] | undefined;
          return [
            {
              spec: {
                ...spec,
                flags: Object.fromEntries(
                  Object.entries(spec.flags ?? {}).map(([name, definition]) => [
                    name,
                    definition.default === undefined ? definition : { ...definition, required: false },
                  ]),
                ),
                args: Object.fromEntries(
                  Object.entries(spec.args ?? {}).map(([name, definition]) => [
                    name,
                    definition.default === undefined ? definition : { ...definition, required: false },
                  ]),
                ),
                run: (input: McpRunInput) =>
                  validateEventCommandInput(spec, {
                    flags: input.flags,
                    args: input.args,
                    raw: input.argv,
                  }).pipe(
                    Effect.flatMap((parsed) => {
                      const normalized = { ...parsed, interaction: "non-interactive" as const };
                      parsedInput = normalized;
                      return spec.run(normalized);
                    }),
                  ),
                ...(spec.completion === undefined
                  ? {}
                  : {
                      completion: (value: unknown) =>
                        spec.completion?.(value, parsedInput as Parameters<typeof spec.run>[0]),
                    }),
              } as unknown as McpCommandEntry["spec"],
            },
          ];
        }),
      ),
  ).pipe(Effect.map((groups) => groups.flat()));
});
