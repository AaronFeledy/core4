import {
  assertMcpAllowlistSafe,
  filterMcpDefaultAllowlist,
  isAppConfigMcpUnsafeId,
  isMcpNeverAllowed,
} from "@lando/mcp/allowlist";
import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { McpToolInputError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import type { RegisteredCommand } from "@lando/sdk/services";
import { Effect } from "effect";
import { appConfigMcpSpecs } from "../../command-specs/app/config";
import { escapeDiagnosticText } from "../../diagnostic-text";
import type { PluginCommandDiagnostic } from "../../plugin-command-catalog";
import type { LandoCommandSpec } from "../../spec/command-spec";
import { toolingSpecFromRegistered } from "./mcp-tooling";

export interface McpCommandRegistry {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry> | undefined;
  readonly diagnostics?: readonly PluginCommandDiagnostic[];
}

export interface ResolvedMcpOptions {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
  readonly tooling: boolean;
  readonly maxConcurrent?: number | undefined;
}

export const mcpRegistryFromBuiltIns = (
  entries: ReadonlyArray<{ readonly spec: McpCommandSpec }>,
): McpCommandRegistry => ({
  commandEntries: entries.flatMap<{ readonly spec: McpCommandSpec }>(({ spec }) => {
    if (isMcpNeverAllowed(spec.id)) return [];
    assertMcpAllowlistSafe(spec);
    if (isAppConfigMcpUnsafeId(spec.id) && spec.id !== "app:config") return [];
    if (spec.id === "app:config") return appConfigMcpSpecs.map((spec: LandoCommandSpec) => ({ spec }));
    return [{ spec }];
  }),
});

export const mcpRegistryWithToolingEntries = (
  registry: McpCommandRegistry,
  commands: ReadonlyArray<RegisteredCommand>,
): McpCommandRegistry => ({
  ...registry,
  toolingEntries: commands
    .filter((command) => !command.hidden)
    .map((command) => ({ spec: toolingSpecFromRegistered(command), tooling: true })),
});

export const knownIdsOf = (registry: McpCommandRegistry): ReadonlySet<string> =>
  new Set([
    ...registry.commandEntries.map((entry) => entry.spec.id),
    ...(registry.toolingEntries ?? []).map((entry) => entry.spec.id),
  ]);

export const defaultIdsOf = (registry: McpCommandRegistry): readonly string[] =>
  filterMcpDefaultAllowlist(MCP_DEFAULT_ALLOWLIST, registry.commandEntries);

/** Plugin command contribution id shape; only a plugin command can satisfy a pending allowance. */
const CANONICAL_COMMAND_ID = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u;

/**
 * Validate session allowances. Malformed and never-allowed ids are rejected; a well-formed id
 * that matches no command yet is a pending allowance (returned), which becomes a tool once a
 * discovered app selects an eligible owner for it.
 */
export const validateMcpAllowlistIds = (
  options: ResolvedMcpOptions,
  knownIds: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<string>, McpToolInputError> => {
  const pending: string[] = [];
  for (const id of options.allow) {
    if (isMcpNeverAllowed(id))
      return Effect.fail(
        new McpToolInputError({
          message: `Command id "${id}" in mcp.allow can never be exposed through MCP.`,
          toolId: id,
          path: "flags.allow",
          remediation: `Remove ${id} from mcp.allow/--allow and run \`lando ${id}\` interactively from a terminal.`,
        }),
      );
    if (isAppConfigMcpUnsafeId(id))
      return Effect.fail(
        new McpToolInputError({
          message: `Command id "${id}" in mcp.allow is not an MCP tool; app configuration is exposed read-only.`,
          toolId: id,
          path: "flags.allow",
          remediation: `Remove ${id} from mcp.allow/--allow; use the app:config:get or app:config:view tools instead.`,
        }),
      );
    if (knownIds.has(id)) continue;
    if (!CANONICAL_COMMAND_ID.test(id))
      return Effect.fail(
        new McpToolInputError({
          message: `Command id "${id}" in mcp.allow is not a canonical Lando command id.`,
          toolId: id,
          path: "flags.allow",
          remediation:
            "Use a canonical colon-separated id such as `app:info`; run `lando mcp --list` to see available ids.",
        }),
      );
    if (!pending.includes(id)) pending.push(id);
  }
  return Effect.succeed(pending);
};

/** Structured `--list` diagnostics for allowances no selected command satisfies yet. */
export const pendingAllowanceDiagnostics = (
  pending: ReadonlyArray<string>,
  redactor: Redactor,
): ReadonlyArray<PluginCommandDiagnostic> =>
  pending.map((id) => ({
    _tag: "McpPendingAllowance",
    message: escapeDiagnosticText(
      redactor.redactString(`Allowed id ${id} matches no command for this app yet; it stays pending.`),
    ),
    remediation: escapeDiagnosticText(
      redactor.redactString(
        `Call a tool with appPath set to an app whose plugin defines ${id} to expose it, or remove it from mcp.allow/--allow.`,
      ),
    ),
  }));
