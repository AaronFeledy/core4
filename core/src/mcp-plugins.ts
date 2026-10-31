import {
  type GraphCommandCandidate,
  PluginContributionGraph,
  type PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { resolvePluginManifests } from "@lando/engine/plugins/manifest-resolution";
import { assertMcpAllowlistSafe, isMcpDestructiveCommand, isMcpNeverAllowed } from "@lando/mcp/allowlist";
import type { McpRunInput } from "@lando/mcp/dispatch";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { RedactionService } from "@lando/redaction/service";
import { McpAllowlistConflictError, McpToolInputError } from "@lando/sdk/errors";
import { Effect, Option, Schema } from "effect";
import type { McpCommandRegistry } from "./cli/commands/meta/mcp-registry";
import { escapeDiagnosticText } from "./cli/diagnostic-text";
import { validateEventCommandInput } from "./cli/event-command-input";
import { type ResolvedPluginCommandSpec, loadPluginSpec } from "./cli/event-command-target";
import type { PluginCommandDiagnostic } from "./cli/plugin-command-catalog";
import { requireConfirmation } from "./cli/require-confirmation";

/** Re-resolve manifests only, never import another app's implementation into the session. */
const assertSelectedOwner = Effect.fn("Mcp.assertSelectedPluginOwner")(function* (
  graph: PluginContributionGraphShape,
  candidate: GraphCommandCandidate,
  appPath: string | undefined,
) {
  if (appPath === undefined) return;
  const selected = yield* resolvePluginManifests({
    bundled: graph.globalPlugins.filter((plugin) => plugin.source !== "explicit"),
    explicit: graph.globalPlugins.filter((plugin) => plugin.source === "explicit"),
    directories: [],
    cwd: appPath,
  });
  const owner = selected.commands.find((command) => command.id === candidate.id);
  const retainedPlugin = graph.plugins.find((plugin) => plugin.manifest.name === candidate.pluginName);
  const retainedPath =
    retainedPlugin !== undefined && "path" in retainedPlugin ? retainedPlugin.path : undefined;
  const targetPlugin = selected.plugins.find((plugin) => plugin.manifest.name === owner?.pluginName);
  if (
    owner?.pluginName !== candidate.pluginName ||
    owner.source !== candidate.source ||
    targetPlugin?.path !== retainedPath
  ) {
    return yield* new McpToolInputError({
      toolId: candidate.id,
      path: "appPath",
      message: "The target app selects a different plugin command owner than this MCP session.",
      remediation: "Reconnect MCP from the target app and use its listed plugin command owner.",
    });
  }
});

const pluginSpec = (
  graph: PluginContributionGraphShape,
  candidate: GraphCommandCandidate,
  spec: ResolvedPluginCommandSpec,
): McpCommandSpec => {
  const { completion, ...command } = spec;
  return {
    ...command,
    mcpAllowed: candidate.descriptor.mcpAllowed === true,
    bindInput: Effect.fn("Mcp.bindPluginInput")(function* (input: McpRunInput) {
      yield* assertSelectedOwner(graph, candidate, input.appPath);
      const bound = yield* validateEventCommandInput(spec, {
        flags: input.flags,
        args: input.args,
        raw: input.argv,
      });
      return { ...input, ...bound, interaction: "non-interactive" as const };
    }),
    run: Effect.fn("Mcp.runPluginCommand")(function* (input: McpRunInput) {
      const destructive = isMcpDestructiveCommand(spec);
      if (destructive) {
        yield* requireConfirmation({ yes: input.flags.yes === true, message: `Run ${spec.id}?` });
      }
      // Accepted general confirmation answers the plugin's own `yes` prompt; protected-target
      // typed confirmation stays the plugin's to collect.
      const pluginInput = {
        ...input,
        ...(destructive && spec.flags?.yes !== undefined ? { flags: { ...input.flags, yes: true } } : {}),
        parsedArgv: input.parsedArgv ?? [],
        interaction: "non-interactive" as const,
      };
      return yield* spec.run(pluginInput);
    }),
    ...(completion === undefined
      ? {}
      : {
          completion: (value: unknown, input: McpRunInput) =>
            completion(value, {
              ...input,
              parsedArgv: input.parsedArgv ?? [],
            }),
        }),
  };
};

export const mcpRegistryWithPlugins = Effect.fn("Mcp.resolvePluginRegistry")(function* (
  registry: McpCommandRegistry,
) {
  const available = yield* Effect.serviceOption(PluginContributionGraph);
  if (Option.isNone(available)) return registry;
  const graph = available.value;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
  const diagnostics: PluginCommandDiagnostic[] = [...(registry.diagnostics ?? [])];
  const addDiagnostic = (error: unknown) => {
    const tagged = Schema.is(
      Schema.Struct({
        _tag: Schema.String,
        message: Schema.String,
        remediation: Schema.optionalKey(Schema.String),
      }),
    )(error);
    diagnostics.push({
      _tag: tagged ? error._tag : "PluginLoadError",
      message: escapeDiagnosticText(redactor.redactString(tagged ? error.message : String(error))).slice(
        0,
        2048,
      ),
      ...(tagged && error.remediation !== undefined
        ? { remediation: escapeDiagnosticText(redactor.redactString(error.remediation)).slice(0, 2048) }
        : {}),
    });
  };
  for (const diagnostic of graph.diagnostics ?? []) addDiagnostic(diagnostic);
  const commandEntries: McpCommandEntry[] = [...registry.commandEntries];
  const knownIds = new Set(commandEntries.map((entry) => entry.spec.id));
  for (const candidate of graph.commands) {
    if (knownIds.has(candidate.id)) continue;
    if (isMcpNeverAllowed(candidate.id)) {
      addDiagnostic(
        new McpAllowlistConflictError({
          message: `Plugin command ${candidate.id} (${candidate.pluginName}) can never be exposed through MCP.`,
          commandId: candidate.id,
          remediation: `Run \`lando ${candidate.id}\` interactively from a terminal; MCP and --allow cannot expose it.`,
        }),
      );
      continue;
    }
    const loaded = yield* Effect.result(
      loadPluginSpec(candidate.id, candidate.pluginName, candidate.load, candidate.descriptor),
    );
    if (loaded._tag === "Failure") {
      addDiagnostic(loaded.failure);
      continue;
    }
    const projected = pluginSpec(graph, candidate, loaded.success);
    const policy = yield* Effect.result(
      Effect.try({ try: () => assertMcpAllowlistSafe(projected), catch: (error) => error }),
    );
    if (policy._tag === "Failure") addDiagnostic(policy.failure);
    commandEntries.push({
      spec: projected,
      plugin: {
        name: candidate.pluginName,
        source: candidate.source === "bundled" ? "bundled" : "external",
        provenance: candidate.source,
      },
    });
    knownIds.add(candidate.id);
  }
  return { ...registry, commandEntries, diagnostics };
});
