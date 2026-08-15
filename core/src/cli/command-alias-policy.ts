import type { AppCommandIndexPayload } from "@lando/engine/cache/command-index";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import { escapeDiagnosticText } from "./diagnostic-text";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";

const MAX_FUZZY_TARGET_LENGTH = 256;
const RESERVED_ALIAS_TOKENS = new Set(["help", "--help", "-h", "--version", "-V", "-v"]);
const BUILT_IN_COMMANDS: ReadonlyArray<{
  readonly aliases: ReadonlyArray<string>;
  readonly spec: { readonly id: string };
}> = Object.values(COMMAND_REGISTRY_MANIFEST.commands);
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

const commandIds = (appCommandIds: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...BUILT_IN_COMMAND_IDS,
  ...appCommandIds,
];

export const commandAliasRegistrationError = (
  policy: CommandAliasPolicyInput | undefined,
  appCommandIds: ReadonlyArray<string>,
): CommandAliasConflictError | CommandAliasTargetError | undefined => {
  if (policy?.enabled === false) return undefined;
  const canonicalIds = commandIds(appCommandIds);
  for (const [alias, target] of Object.entries(policy?.custom ?? {})) {
    const safeAlias = escapeDiagnosticText(alias);
    const safeTarget = escapeDiagnosticText(target);
    const conflictsWithCanonicalId = canonicalIds.includes(alias);
    const namespaceHead = alias.split(":", 1)[0] ?? alias;
    const conflictsWithReservedNamespace =
      RESERVED_NAMESPACE_HEADS.has(namespaceHead) && !REGISTERED_ALIASES.has(alias);
    if (
      conflictsWithCanonicalId ||
      alias.startsWith("-") ||
      RESERVED_ALIAS_TOKENS.has(alias) ||
      conflictsWithReservedNamespace
    ) {
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
      const closeMatches =
        target.length > MAX_FUZZY_TARGET_LENGTH
          ? []
          : canonicalIds
              .map((commandId) => ({ commandId, distance: editDistance(target, commandId) }))
              .sort(
                (left, right) =>
                  left.distance - right.distance || left.commandId.localeCompare(right.commandId),
              )
              .slice(0, 3)
              .map(({ commandId }) => commandId);
      return new CommandAliasTargetError({
        message: `Top-level alias ${safeAlias} targets unknown canonical command ${safeTarget}.`,
        alias,
        target,
        closeMatches,
        remediation: `Choose a registered canonical command${closeMatches.length === 0 ? "" : ` such as ${closeMatches.join(", ")}`} or run \`lando app:cache:refresh\` after adding the target.`,
      });
    }
  }
  return undefined;
};

export const commandAliasPolicyError = (
  cache: AppCommandIndexPayload,
): CommandAliasConflictError | CommandAliasTargetError | undefined =>
  commandAliasRegistrationError(
    cache.aliasPolicy,
    cache.entries.map((entry) => entry.id),
  );

export const activeCommandAliases = (
  cache: AppCommandIndexPayload,
): ReadonlyArray<readonly [string, string]> => {
  const policy = cache.aliasPolicy;
  if (policy?.enabled === false) return [];
  const aliases = new Map<string, string>();
  for (const entry of BUILT_IN_COMMANDS) {
    for (const alias of entry.aliases) {
      if (!alias.startsWith("-")) aliases.set(alias, entry.spec.id);
    }
  }
  for (const alias of policy?.disabled ?? []) aliases.delete(alias);
  for (const [alias, target] of Object.entries(policy?.custom ?? {})) aliases.set(alias, target);
  return [...aliases].sort(([left], [right]) => left.localeCompare(right));
};
