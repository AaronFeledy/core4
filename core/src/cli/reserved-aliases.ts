import { CommandAliasConflictError } from "@lando/sdk/errors";

const RESERVED_EXACT_ALIAS_OWNERS = new Map<string, string>([
  ["run", "apps:scratch:run"],
  ["scratch", "apps:scratch:start"],
]);

const SCRATCH_ALIAS_PREFIX = "scratch:";

export const reservedTopLevelAliasOwner = (alias: string): string | undefined => {
  const exact = RESERVED_EXACT_ALIAS_OWNERS.get(alias);
  if (exact !== undefined) return exact;
  if (alias.startsWith(SCRATCH_ALIAS_PREFIX)) return `apps:${alias}`;
  return undefined;
};

export const commandAliasConflictError = (alias: string, claimedBy: string): CommandAliasConflictError => {
  const reservedFor = reservedTopLevelAliasOwner(alias) ?? alias;
  return new CommandAliasConflictError({
    message: `Top-level alias ${alias} is reserved for the built-in ${reservedFor} command and cannot be claimed by ${claimedBy}.`,
    alias,
    claimedBy,
    reservedFor,
    remediation: `Rename ${claimedBy}, or remap the alias for this app via commandAliases.custom; ${reservedFor} stays callable by its canonical id.`,
  });
};

export const assertTopLevelAliasesClaimable = (commandId: string, aliases: ReadonlyArray<string>): void => {
  for (const alias of aliases) {
    const owner = reservedTopLevelAliasOwner(alias);
    if (owner !== undefined && owner !== commandId) {
      throw commandAliasConflictError(alias, `command ${commandId}`);
    }
  }
};

export const assertToolingNameClaimable = (name: string, claimedBy: string): void => {
  if (reservedTopLevelAliasOwner(name) !== undefined) {
    throw commandAliasConflictError(name, claimedBy);
  }
};
