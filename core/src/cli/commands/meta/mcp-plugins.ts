import type {
  GraphCommandCandidate,
  PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { assertMcpAllowlistSafe, isMcpDestructiveCommand, isMcpNeverAllowed } from "@lando/mcp/allowlist";
import type { McpGenerationCommand } from "@lando/mcp/apps";
import type { McpRunInput } from "@lando/mcp/dispatch";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { RedactionService } from "@lando/redaction/service";
import { McpAllowlistConflictError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Option, Schema } from "effect";
import { escapeDiagnosticText } from "../../diagnostic-text";
import { validateEventCommandInput } from "../../event-command-input";
import { type ResolvedPluginCommandSpec, loadPluginSpec } from "../../event-command-target";
import { CliInvocation } from "../../invocation-context";
import type { PluginCommandDiagnostic } from "../../plugin-command-catalog";
import { requireConfirmation } from "../../require-confirmation";
import type { McpCommandRegistry } from "./mcp-registry";

const pluginSpec = (candidate: GraphCommandCandidate, spec: ResolvedPluginCommandSpec): McpCommandSpec => {
  const { completion, ...command } = spec;
  return {
    ...command,
    mcpAllowed: candidate.descriptor.mcpAllowed === true,
    bindInput: Effect.fn("Mcp.bindPluginInput")(function* (input: McpRunInput) {
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

const isTaggedDiagnostic = Schema.is(
  Schema.Struct({
    _tag: Schema.String,
    message: Schema.String,
    remediation: Schema.optionalKey(Schema.String),
  }),
);

/** A redacted, escaped, bounded diagnostic for a plugin failure or MCP policy refusal. */
export const mcpPluginDiagnostic = (error: unknown, redactor: Redactor): PluginCommandDiagnostic => {
  const tagged = isTaggedDiagnostic(error);
  return {
    _tag: tagged ? error._tag : "PluginLoadError",
    message: escapeDiagnosticText(redactor.redactString(tagged ? error.message : String(error))).slice(
      0,
      2048,
    ),
    ...(tagged && error.remediation !== undefined
      ? { remediation: escapeDiagnosticText(redactor.redactString(error.remediation)).slice(0, 2048) }
      : {}),
  };
};

export interface McpPluginProjection {
  /** Every selected plugin command id MCP can reach, with its owner or that owner's load failure. */
  readonly commands: ReadonlyMap<string, McpGenerationCommand>;
  readonly diagnostics: ReadonlyArray<PluginCommandDiagnostic>;
}

/** Project one selected owner: its MCP entry, or that owner's own load failure. */
const projectCandidate = Effect.fnUntraced(function* (candidate: GraphCommandCandidate, redactor: Redactor) {
  const diagnostics: PluginCommandDiagnostic[] = [];
  const loaded = yield* Effect.result(
    loadPluginSpec(candidate.id, candidate.pluginName, candidate.load, candidate.descriptor),
  );
  if (loaded._tag === "Failure") {
    diagnostics.push(mcpPluginDiagnostic(loaded.failure, redactor));
    const command: McpGenerationCommand = { _tag: "Failed", commandId: candidate.id, error: loaded.failure };
    return { command, diagnostics };
  }
  const spec = pluginSpec(candidate, loaded.success);
  const policy = yield* Effect.result(
    Effect.try({ try: () => assertMcpAllowlistSafe(spec), catch: (error) => error }),
  );
  if (policy._tag === "Failure") diagnostics.push(mcpPluginDiagnostic(policy.failure, redactor));
  const command: McpGenerationCommand = {
    _tag: "Eligible",
    entry: {
      spec,
      plugin: {
        name: candidate.pluginName,
        source: candidate.source === "bundled" ? "bundled" : "external",
        provenance: candidate.source,
      },
    },
  };
  return { command, diagnostics };
});

/**
 * Project a contribution graph's selected plugin commands for MCP. Each id keeps exactly the
 * owner the graph selected: a load failure stays that owner's failure instead of exposing a
 * shadowed owner, and never-allowed ids are refused outright. `sessionIds` (built-ins) win.
 */
export const projectMcpPluginCommands = Effect.fn("Mcp.projectPluginCommands")(function* (
  graph: PluginContributionGraphShape,
  sessionIds: ReadonlySet<string>,
  redactor: Redactor,
) {
  const diagnostics = (graph.diagnostics ?? []).map((diagnostic) =>
    mcpPluginDiagnostic(diagnostic, redactor),
  );
  const commands = new Map<string, McpGenerationCommand>();
  for (const candidate of graph.commands) {
    if (sessionIds.has(candidate.id) || commands.has(candidate.id)) continue;
    if (isMcpNeverAllowed(candidate.id)) {
      diagnostics.push(
        mcpPluginDiagnostic(
          new McpAllowlistConflictError({
            message: `Plugin command ${candidate.id} (${candidate.pluginName}) can never be exposed through MCP.`,
            commandId: candidate.id,
            remediation: `Run \`lando ${candidate.id}\` interactively from a terminal; MCP and --allow cannot expose it.`,
          }),
          redactor,
        ),
      );
      continue;
    }
    const projected = yield* projectCandidate(candidate, redactor);
    diagnostics.push(...projected.diagnostics);
    commands.set(candidate.id, projected.command);
  }
  return { commands, diagnostics } satisfies McpPluginProjection;
});

/**
 * Retry each failed owner's projection against the same selected owner. A fix the generation's
 * fingerprint cannot see (a lazily imported command module) takes effect without a rebuild; an
 * owner that still fails keeps its failure, and no other owner is ever promoted. Returns the
 * updated commands, or undefined when nothing recovered.
 */
export const retryFailedMcpPluginCommands = Effect.fn("Mcp.retryFailedPluginCommands")(function* (
  graph: PluginContributionGraphShape,
  commands: ReadonlyMap<string, McpGenerationCommand>,
  redactor: Redactor,
) {
  let next: Map<string, McpGenerationCommand> | undefined;
  for (const command of commands.values()) {
    if (command._tag !== "Failed") continue;
    const candidate = graph.commands.find((owner) => owner.id === command.commandId);
    if (candidate === undefined) continue;
    const projected = yield* projectCandidate(candidate, redactor);
    if (projected.command._tag !== "Eligible") continue;
    next ??= new Map(commands);
    next.set(command.commandId, projected.command);
  }
  return next;
});

/** Eligible owners of a projection, in selection order. */
export const eligibleMcpEntries = (projection: McpPluginProjection): ReadonlyArray<McpCommandEntry> =>
  [...projection.commands.values()].flatMap((command) =>
    command._tag === "Eligible" ? [command.entry] : [],
  );

/** Add the contribution graph in context (if any) to a built-in registry, for `--list` and tests. */
export const mcpRegistryWithPlugins = Effect.fn("Mcp.resolvePluginRegistry")(function* (
  registry: McpCommandRegistry,
) {
  const available = yield* Effect.serviceOption(PluginContributionGraph);
  if (Option.isNone(available)) return registry;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: (yield* CliInvocation).env });
  const projection = yield* projectMcpPluginCommands(
    available.value,
    new Set(registry.commandEntries.map((entry) => entry.spec.id)),
    redactor,
  );
  return {
    ...registry,
    commandEntries: [...registry.commandEntries, ...eligibleMcpEntries(projection)],
    diagnostics: [...(registry.diagnostics ?? []), ...projection.diagnostics],
  };
});
