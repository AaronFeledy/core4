import { isMcpEntryAuthorized, isMcpToolingAuthorized, makeMcpAllowPolicy } from "@lando/mcp/catalog";
import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import { boundDiagnostics, pluginDiagnostics } from "@lando/mcp/service";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { Effect, Option } from "effect";
import { buildMcpListResult } from "./mcp-list";
import {
  type McpCommandRegistry,
  type ResolvedMcpOptions,
  defaultIdsOf,
  pendingAllowanceDiagnostics,
} from "./mcp-registry";

export const listMcpCatalog = Effect.fnUntraced(function* (
  registry: McpCommandRegistry,
  options: ResolvedMcpOptions,
  pending: readonly string[],
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(redaction)
    ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
    : createStandaloneRedactor("secrets", { sourceEnv: process.env });
  const policy = makeMcpAllowPolicy({
    defaults: MCP_DEFAULT_ALLOWLIST,
    allow: options.allow,
    deny: options.deny,
  });
  const toolingIds = new Set(
    options.tooling
      ? [
          ...(registry.toolingEntries ?? []).map((entry) => entry.spec.id),
          ...(registry.toolingUnavailable ?? []).map((entry) => entry.commandId),
        ]
      : [],
  );
  const diagnostics = boundDiagnostics(
    0,
    [
      ...(registry.generation === undefined
        ? []
        : pluginDiagnostics(registry.generation, policy).filter(
            (record) => !toolingIds.has(record.commandId),
          )),
      ...(options.tooling ? (registry.toolingUnavailable ?? []) : []).filter((record) =>
        isMcpToolingAuthorized(policy, record.commandId),
      ),
    ],
    redactor,
  );
  return buildMcpListResult({
    defaultAllowlist: defaultIdsOf(registry),
    commandEntries: registry.commandEntries.filter(
      (entry) =>
        entry.plugin === undefined || (!toolingIds.has(entry.spec.id) && isMcpEntryAuthorized(policy, entry)),
    ),
    ...(registry.toolingEntries === undefined ? {} : { toolingEntries: registry.toolingEntries }),
    allow: options.allow,
    deny: options.deny,
    tooling: options.tooling,
    diagnostics: [
      ...(registry.generation === undefined ? (registry.diagnostics ?? []) : diagnostics.diagnostics),
      ...pendingAllowanceDiagnostics(
        pending.filter((id) => !policy.deny.has(id)),
        redactor,
      ),
    ],
    omittedDiagnosticCount: diagnostics.omittedDiagnosticCount,
  });
});
