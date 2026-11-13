import type { ToolingInputDeclaration } from "@lando/sdk/schema";

import { type FlagDefinition, flagDefinitionsByToken, normalizeCliFlagTokens } from "./flag-tokens";
import type { CommandClaim, OwnerPolicy } from "./invocation";
import { RESERVED_OUTPUT_SPELLINGS } from "./lando-flags";

/**
 * What a command's argv claims, independent of where its owner came from.
 *
 * These helpers must not import the command registry or the owner resolver:
 * generated tables and code generators import the plugin/flag definitions
 * before either exists.
 */

/**
 * Flags whose bare form takes no value; `--mount-cwd` selects its default
 * target. The claims and value validation both read this one table.
 */
export const BARE_VALUE_FLAGS_BY_COMMAND: Readonly<Record<string, ReadonlyArray<string>>> = {
  "apps:scratch:start": ["mount-cwd"],
};

export const NO_CLAIMS = (): CommandClaim | undefined => undefined;

export const nonePolicy = (reservedOutput: boolean): OwnerPolicy => ({
  tail: "none",
  claims: NO_CLAIMS,
  reservedOutput: reservedOutput ? RESERVED_OUTPUT_SPELLINGS : [],
});

export interface SpecPolicyShape {
  readonly id: string;
  readonly strict?: boolean;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** A non-strict command declaring a `command` arg owns its tail, like `exec`. */
export const specTailKind = (spec: SpecPolicyShape | undefined): "none" | "command" =>
  spec !== undefined && spec.strict === false && spec.args?.command !== undefined ? "command" : "none";

const bareValueFlags = (commandId: string | undefined): ReadonlySet<string> =>
  new Set(commandId === undefined ? [] : (BARE_VALUE_FLAGS_BY_COMMAND[commandId] ?? []));

/**
 * The flags a built-in or plugin spec declares. A bundle of short flags is
 * judged by its last flag; a bare-value flag has no value slot.
 */
export const specFlagClaims = (
  definitions: Readonly<Record<string, unknown>>,
  commandId: string | undefined,
): OwnerPolicy["claims"] => {
  const byToken: ReadonlyMap<string, FlagDefinition> = flagDefinitionsByToken(definitions);
  const bare = bareValueFlags(commandId);
  return (token, next) => {
    const last = normalizeCliFlagTokens([token], definitions).at(-1);
    if (last === undefined) return undefined;
    const equalsIndex = last.indexOf("=");
    const name = equalsIndex === -1 ? last : last.slice(0, equalsIndex);
    const definition = byToken.get(name);
    if (definition === undefined) return undefined;
    if (equalsIndex !== -1) return { takesNext: false };
    if (definition.boolean || bare.has(definition.name) || next === "--") return { takesNext: false };
    return { takesNext: true };
  };
};

const toolingFlagFor = (
  token: string,
  flags: ToolingInputDeclaration["flags"],
): ToolingInputDeclaration["flags"][number] | undefined => {
  if (token === "-" || token === "--" || !token.startsWith("-")) return undefined;
  const long = token.startsWith("--");
  const option = token.slice(long ? 2 : 1);
  const equalsIndex = option.indexOf("=");
  const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
  return flags.find((flag) => (long ? flag.name === key : flag.alias === key));
};

/**
 * Tooling tasks and scripts: a declared spelling owns its token and, when it
 * takes a value, the adjacent one. A declared `help` flag or `h` alias owns
 * both help spellings; `--version`/`-v` are always the task's.
 */
export const toolingFlagClaims = (
  declaration: ToolingInputDeclaration | undefined,
): OwnerPolicy["claims"] => {
  const flags = declaration?.flags ?? [];
  const declaresHelp = flags.some((flag) => flag.name === "help" || flag.alias === "h");
  return (token, next) => {
    if (token === "--version" || token === "-v") return { takesNext: false };
    if (declaresHelp && (token === "--help" || token === "-h")) return { takesNext: false };
    const declared = toolingFlagFor(token, flags);
    if (declared === undefined) return undefined;
    if (declared.boolean || token.includes("=")) return { takesNext: false };
    return { takesNext: next !== undefined && next !== "--" };
  };
};

/**
 * The owner policy for a built-in or plugin spec. `meta:bun` and `meta:x` own
 * every token after their name; other specs decide by tail kind.
 */
export const specOwnerPolicy = (
  spec: SpecPolicyShape,
  definitions: Readonly<Record<string, unknown>>,
): OwnerPolicy => {
  const tail = spec.id === "meta:bun" || spec.id === "meta:x" ? "all" : specTailKind(spec);
  return {
    tail,
    claims: tail === "all" ? NO_CLAIMS : specFlagClaims(definitions, spec.id),
    reservedOutput: RESERVED_OUTPUT_SPELLINGS,
  };
};
