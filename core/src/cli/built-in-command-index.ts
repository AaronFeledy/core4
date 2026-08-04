import { CommandRegistrationError } from "./oclif/command-spec.ts";
import { commandAliasConflictError } from "./reserved-aliases.ts";

type BuiltInCommandRegistration = {
  readonly spec: { readonly id: string };
  readonly command: { readonly aliases?: ReadonlyArray<string> };
};

export type BuiltInCommandIndex<T extends BuiltInCommandRegistration> = {
  readonly entries: ReadonlyArray<T>;
  readonly byToken: ReadonlyMap<string, T>;
};

export const buildBuiltInCommandIndex = <T extends BuiltInCommandRegistration>(
  registrations: ReadonlyArray<readonly [string, T]>,
): BuiltInCommandIndex<T> => {
  const entries: T[] = [];
  const byToken = new Map<string, T>();
  for (const [key, entry] of [...registrations].sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== entry.spec.id) {
      throw new CommandRegistrationError({
        message: `Built-in command registry key ${key} does not match command spec id ${entry.spec.id}.`,
        commandId: entry.spec.id,
        remediation: `Register ${entry.spec.id} under its canonical registry key.`,
      });
    }
    for (const token of [entry.spec.id, ...(entry.command.aliases ?? [])]) {
      const owner = byToken.get(token);
      if (owner !== undefined) {
        throw commandAliasConflictError(token, `command ${entry.spec.id}`, owner.spec.id);
      }
      byToken.set(token, entry);
    }
    entries.push(entry);
  }
  return { entries, byToken };
};
