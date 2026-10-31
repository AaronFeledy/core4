import { assertMcpAllowlistSafe, isAppConfigMcpUnsafeId } from "@lando/mcp/allowlist";
import type { McpCommandEntry, McpCommandSpec } from "@lando/mcp/registry";
import { McpToolInputError } from "@lando/sdk/errors";
import type { RegisteredCommand } from "@lando/sdk/services";
import { Effect } from "effect";
import { appConfigMcpSpecs } from "../../command-specs/app/config";
import type { LandoCommandSpec } from "../../spec/command-spec";
import { toolingSpecFromRegistered } from "./mcp-tooling";

export interface McpCommandRegistry {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry> | undefined;
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
  commandEntries: registry.commandEntries,
  toolingEntries: commands
    .filter((command) => !command.hidden)
    .map((command) => ({ spec: toolingSpecFromRegistered(command), tooling: true })),
});

export const knownIdsOf = (registry: McpCommandRegistry): ReadonlySet<string> =>
  new Set([
    ...registry.commandEntries.map((entry) => entry.spec.id),
    ...(registry.toolingEntries ?? []).map((entry) => entry.spec.id),
  ]);

export const validateMcpAllowlistIds = (
  options: ResolvedMcpOptions,
  knownIds: ReadonlySet<string>,
): Effect.Effect<void, McpToolInputError> => {
  for (const id of options.allow) {
    if (!knownIds.has(id))
      return Effect.fail(
        new McpToolInputError({
          message: `Unknown command id "${id}" in mcp.allow.`,
          toolId: id,
          path: "flags.allow",
          remediation: "Use a canonical Lando command id; run `lando mcp --list` to see available ids.",
        }),
      );
  }
  return Effect.void;
};
