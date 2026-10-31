import type { AppCommandIndexPayload, CommandIndexEntry } from "@lando/engine/cache/command-index";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import { buildCommandCatalog } from "./command-catalog";
import { escapeDiagnosticText } from "./diagnostic-text";
import { BUNDLED_COMMAND_DESCRIPTORS } from "./generated/bundled-command-descriptors";
import type { PluginCommandRow } from "./plugin-command-catalog";

const RESERVED_ALIAS_TOKENS = new Set(["help", "--help", "-h", "--version", "-V", "-v"]);
const BUNDLED_ROWS: readonly PluginCommandRow[] = BUNDLED_COMMAND_DESCRIPTORS.map((descriptor) => ({
  id: descriptor.id,
  summary: descriptor.summary,
  descriptor,
  pluginName: descriptor.pluginName,
  source: "bundled",
}));
const BASE_CATALOG = buildCommandCatalog(BUNDLED_ROWS);
const BUILT_IN_COMMANDS: ReadonlyArray<{
  readonly aliases: ReadonlyArray<string>;
  readonly spec: { readonly id: string };
}> = BASE_CATALOG.entries
  .filter((entry) => entry.source === "built-in")
  .map((entry) => ({ spec: { id: entry.id }, aliases: entry.tokens.filter((token) => token !== entry.id) }));
const BUILT_IN_COMMAND_IDS = BUILT_IN_COMMANDS.map((entry) => entry.spec.id);
const REGISTERED_ALIASES = new Set(
  BUILT_IN_COMMANDS.flatMap((entry) => entry.aliases).filter((alias) => !alias.startsWith("-")),
);
const RESERVED_NAMESPACE_HEADS = new Set(
  [...BUILT_IN_COMMAND_IDS, ...REGISTERED_ALIASES].flatMap((token) => {
    const [head, remainder] = token.split(":", 2);
    return head !== undefined && remainder !== undefined ? [head] : [];
  }),
);

interface CommandAliasPolicyInput {
  readonly enabled?: boolean | undefined;
  readonly disabled?: ReadonlyArray<string> | undefined;
  readonly custom?: Readonly<Record<string, string>> | undefined;
}

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const diagonal = previous[rightIndex - 1] ?? rightIndex - 1;
      const substitution = diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? rightIndex) + 1,
        (previous[rightIndex] ?? leftIndex) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
};

export const commandAliasRegistrationError = (
  policy: CommandAliasPolicyInput | undefined,
  appCommandIds: ReadonlyArray<string>,
  entries: ReadonlyArray<CommandIndexEntry> = [],
  pluginIds: readonly string[] = BASE_CATALOG.entries
    .filter((entry) => entry.source === "plugin")
    .map((entry) => entry.id),
): CommandAliasConflictError | CommandAliasTargetError | undefined => {
  for (const entry of entries) {
    if (entry.source !== "bun-script") continue;
    const name = entry.id.slice("app:".length);
    const canonicalOwner = BUILT_IN_COMMANDS.find((command) => command.spec.id === entry.id);
    const aliasOwner =
      name.includes(":") ||
      policy?.enabled === false ||
      policy?.disabled?.includes(name) ||
      policy?.custom?.[name] !== undefined
        ? undefined
        : BUILT_IN_COMMANDS.find((command) => command.aliases.includes(name));
    const reservedFor =
      canonicalOwner?.spec.id ?? aliasOwner?.spec.id ?? (RESERVED_ALIAS_TOKENS.has(name) ? name : undefined);
    if (reservedFor === undefined) continue;
    const alias = canonicalOwner === undefined ? name : entry.id;
    const safeId = escapeDiagnosticText(entry.id);
    return new CommandAliasConflictError({
      message: `Script command ${safeId} conflicts with built-in command ${escapeDiagnosticText(reservedFor)}.`,
      alias,
      claimedBy: `script ${entry.id}`,
      reservedFor,
      remediation: `Rename the .bun.sh script that registers ${safeId}, then run \`lando app:cache:refresh\`.`,
    });
  }
  if (policy?.enabled === false) return undefined;
  const canonicalIds = [...BUILT_IN_COMMAND_IDS, ...appCommandIds, ...pluginIds];
  for (const [alias, target] of Object.entries(policy?.custom ?? {})) {
    const safeAlias = escapeDiagnosticText(alias);
    const safeTarget = escapeDiagnosticText(target);
    const conflictsWithCanonicalId = canonicalIds.includes(alias);
    const namespaceHead = alias.split(":", 1)[0] ?? alias;
    const conflictsWithReservedNamespace =
      RESERVED_NAMESPACE_HEADS.has(namespaceHead) && !REGISTERED_ALIASES.has(alias);
    const conflictsWithReservedToken = alias.startsWith("-") || RESERVED_ALIAS_TOKENS.has(alias);
    if (conflictsWithCanonicalId || conflictsWithReservedToken || conflictsWithReservedNamespace) {
      // Canonical id collisions report the full alias; reserved-namespace heads report the head.
      const reservedFor = conflictsWithCanonicalId
        ? alias
        : conflictsWithReservedNamespace
          ? namespaceHead
          : alias;
      return new CommandAliasConflictError({
        message: conflictsWithCanonicalId
          ? `Top-level alias ${safeAlias} conflicts with canonical command id ${safeAlias}.`
          : `Top-level alias ${safeAlias} conflicts with reserved command token ${safeAlias}.`,
        alias,
        claimedBy: `commandAliases.custom.${alias}`,
        reservedFor,
        remediation: conflictsWithCanonicalId
          ? `Rename commandAliases.custom.${safeAlias}; ${safeAlias} stays callable by its canonical id.`
          : `Rename commandAliases.custom.${safeAlias}; ${safeAlias} remains reserved for canonical command routing.`,
      });
    }
    if (!canonicalIds.includes(target)) {
      const closeMatches = canonicalIds
        .map((commandId) => ({ commandId, distance: editDistance(target, commandId) }))
        .sort(
          (left, right) => left.distance - right.distance || left.commandId.localeCompare(right.commandId),
        )
        .slice(0, 3)
        .map(({ commandId }) => commandId);
      return new CommandAliasTargetError({
        message: `Top-level alias ${safeAlias} targets unknown canonical command ${safeTarget}.`,
        alias,
        target,
        closeMatches,
        remediation: `Choose a registered canonical command${closeMatches.length === 0 ? "" : ` such as ${closeMatches.map(escapeDiagnosticText).join(", ")}`} or run \`lando app:cache:refresh\` after adding the target.`,
      });
    }
  }
  return undefined;
};

export const commandAliasPolicyError = (
  cache: AppCommandIndexPayload,
  pluginIds?: readonly string[],
): CommandAliasConflictError | CommandAliasTargetError | undefined =>
  commandAliasRegistrationError(
    cache.aliasPolicy,
    cache.entries.map((entry) => entry.id),
    cache.entries,
    pluginIds,
  );

export const activeCommandAliases = (
  cache: AppCommandIndexPayload,
  plugins: readonly PluginCommandRow[] = BUNDLED_ROWS,
): ReadonlyArray<readonly [string, string]> => {
  const policy = cache.aliasPolicy;
  if (policy?.enabled === false) return [];
  const catalog = buildCommandCatalog(plugins, cache);
  const aliases = new Map<string, string>();
  for (const [token, entry] of catalog.byToken)
    if (
      token !== entry.id &&
      !token.startsWith("-") &&
      (entry.source !== "tooling" || policy?.custom?.[token] === entry.id)
    )
      aliases.set(token, entry.id);
  return [...aliases].sort(([left], [right]) => left.localeCompare(right));
};
