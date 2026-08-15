import type { AppCommandIndexPayload } from "@lando/engine/cache/command-index";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import {
  type BuiltInCommandEntry,
  builtInCommandEntries,
  isReservedNamespaceHead,
} from "./built-in-command-registry";

const RESERVED_ALIAS_TOKENS = new Set(["help", "--help", "-h", "--version", "-V", "-v"]);
const REGISTERED_ALIASES = new Set(
  builtInCommandEntries
    .flatMap((entry) => entry.command.aliases ?? [])
    .filter((alias) => !alias.startsWith("-")),
);

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

const commandIds = (cache: AppCommandIndexPayload): ReadonlyArray<string> => [
  ...builtInCommandEntries.map((entry) => entry.spec.id),
  ...cache.entries.map((entry) => entry.id),
];

export const canonicalBuiltIn = (commandId: string): BuiltInCommandEntry | undefined =>
  builtInCommandEntries.find((entry) => entry.spec.id === commandId);

export const commandAliasPolicyError = (
  cache: AppCommandIndexPayload,
): CommandAliasConflictError | CommandAliasTargetError | undefined => {
  const canonicalIds = commandIds(cache);
  for (const [alias, target] of Object.entries(cache.aliasPolicy?.custom ?? {})) {
    const conflictsWithCanonicalId = canonicalIds.includes(alias);
    const namespaceHead = alias.split(":", 1)[0] ?? alias;
    const conflictsWithReservedNamespace =
      isReservedNamespaceHead(namespaceHead) && !REGISTERED_ALIASES.has(alias);
    if (conflictsWithCanonicalId || RESERVED_ALIAS_TOKENS.has(alias) || conflictsWithReservedNamespace) {
      const reservedFor = conflictsWithCanonicalId
        ? alias
        : conflictsWithReservedNamespace
          ? namespaceHead
          : alias;
      return new CommandAliasConflictError({
        message: conflictsWithCanonicalId
          ? `Top-level alias ${alias} conflicts with canonical command id ${alias}.`
          : `Top-level alias ${alias} conflicts with reserved command token ${alias}.`,
        alias,
        claimedBy: `commandAliases.custom.${alias}`,
        reservedFor,
        remediation: conflictsWithCanonicalId
          ? `Rename commandAliases.custom.${alias}; ${alias} stays callable by its canonical id.`
          : `Rename commandAliases.custom.${alias}; ${alias} remains reserved for canonical command routing.`,
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
        message: `Top-level alias ${alias} targets unknown canonical command ${target}.`,
        alias,
        target,
        closeMatches,
        remediation: `Choose a registered canonical command${closeMatches.length === 0 ? "" : ` such as ${closeMatches.join(", ")}`} or run \`lando app:cache:refresh\` after adding the target.`,
      });
    }
  }
  return undefined;
};

export const activeCommandAliases = (
  cache: AppCommandIndexPayload,
): ReadonlyArray<readonly [string, string]> => {
  const policy = cache.aliasPolicy;
  if (policy?.enabled === false) return [];
  const aliases = new Map<string, string>();
  for (const entry of builtInCommandEntries) {
    for (const alias of entry.command.aliases ?? []) {
      if (!alias.startsWith("-")) aliases.set(alias, entry.spec.id);
    }
  }
  for (const alias of policy?.disabled ?? []) aliases.delete(alias);
  for (const [alias, target] of Object.entries(policy?.custom ?? {})) aliases.set(alias, target);
  return [...aliases].sort(([left], [right]) => left.localeCompare(right));
};
