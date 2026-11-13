import type { ToolingInputDeclaration } from "@lando/sdk/schema";
import { normalizeCompiledCommandArgv } from "./compiled-normalize";
import { type FlagDefinition, flagDefinitionsByToken, normalizeCliFlagTokens } from "./flag-tokens";
import { LANDO_FLAGS, type LandoFlagMatch, matchLandoFlag } from "./lando-flags";

/**
 * The one lexical contract for a CLI invocation.
 *
 * Nothing outside this module decides whether a token is Lando's. The table in
 * `lando-flags.ts` is the dispatcher-owned surface; `resolveInvocationHead`
 * finds the command name through it, and `splitInvocation` partitions argv into
 * the tokens Lando reads and the tokens the command receives.
 *
 * Original adjacency is authoritative: a flag's value is the token next to it
 * in what the user typed. Removing a flag never makes two tokens adjacent.
 */

/**
 * Whether a match is Lando's to read: selection and reserved flags are
 * stripped into `globals`; help and version stay in argv for the help/version
 * logic.
 */
const isLandoOwned = (match: LandoFlagMatch): boolean =>
  match.flag.role === "selection" || match.flag.role === "reserved";

/**
 * Whether `spelling` is a flag Lando acts on, and whether it takes a value.
 * Reserved task-tree flags are not features, so they do not count.
 */
export const landoFlagForSpelling = (spelling: string): { readonly takesValue: boolean } | undefined => {
  const flag = LANDO_FLAGS.find((entry) => entry.spelling === spelling);
  if (flag === undefined || flag.role === "reserved") return undefined;
  return { takesValue: flag.arity === "value" };
};

/**
 * Whether a command's own flag token takes the adjacent token as its value: the
 * flag is declared, is not boolean, carries no `=` value, and the adjacent token
 * is not `--`. A bundle of short flags is judged by its last flag.
 */
export const commandFlagTakesNext = (
  token: string,
  next: string | undefined,
  definitions: Readonly<Record<string, unknown>>,
  byToken: ReadonlyMap<string, FlagDefinition> = flagDefinitionsByToken(definitions),
): boolean => {
  const last = normalizeCliFlagTokens([token], definitions).at(-1);
  if (last === undefined || last.includes("=")) return false;
  const definition = byToken.get(last);
  return definition !== undefined && !definition.boolean && next !== "--";
};

export type TailPolicy =
  /** Rule 3: table-only classification until `--`. */
  | { readonly kind: "none" }
  /** Tail at the first `--`, else the first positional; table flags before it stay Lando's. */
  | { readonly kind: "command"; readonly flags: Readonly<Record<string, unknown>> }
  /** The tail is everything after the command name. */
  | { readonly kind: "all" }
  /** Tooling tasks and scripts: declared spellings own their tokens; everything else is table-classified until `--`. */
  | { readonly kind: "declared"; readonly flags: ToolingInputDeclaration["flags"] };

export interface InvocationHead {
  /** Index of the last command-name token; unused when there is no owner. */
  readonly commandEndIndex: number;
  /** Original indices of the tokens that spell the command name. */
  readonly commandWordIndices: ReadonlyArray<number>;
  /** The normalized command id, when a command name was found. */
  readonly commandId?: string;
  /** Stripped dispatcher tokens encountered before the command region, in original order. */
  readonly headGlobals: ReadonlyArray<string>;
}

const emptyHead = (commandIndex: number, headGlobals: ReadonlyArray<string>): InvocationHead => ({
  commandEndIndex: commandIndex - 1,
  commandWordIndices: [],
  headGlobals,
});

/**
 * Find the command name through interleaved dispatcher flags and normalize
 * multi-word heads. A leading token that is neither a dispatcher flag nor a
 * command word means there is no owner: the dispatcher keeps today's behavior
 * of failing on the first token.
 */
export const resolveInvocationHead = (argv: ReadonlyArray<string>): InvocationHead => {
  const headGlobals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      index += 1;
      continue;
    }
    if (token === "--") return emptyHead(index, headGlobals);
    if (token === "-" || !token.startsWith("-")) break;
    const match = matchLandoFlag(token, argv[index + 1]);
    // An unknown leading flag is not a command, and a leading help or version flag is Lando's to answer.
    if (match === undefined || !isLandoOwned(match)) return emptyHead(argv.length, headGlobals);
    const value = argv[index + 1];
    headGlobals.push(token);
    if (match.consumed === 1 && value !== undefined) headGlobals.push(value);
    index += 1 + match.consumed;
  }
  if (index >= argv.length) return emptyHead(argv.length, headGlobals);

  const words: string[] = [];
  const commandWordIndices: number[] = [];
  const globalEntries: Array<{ readonly index: number; readonly tokens: ReadonlyArray<string> }> = [];
  let cursor = index;
  while (cursor < argv.length) {
    const token = argv[cursor];
    if (token === undefined) {
      cursor += 1;
      continue;
    }
    if (token === "--") break;
    if (token === "-" || !token.startsWith("-")) {
      words.push(token);
      commandWordIndices.push(cursor);
      cursor += 1;
      continue;
    }
    const match = matchLandoFlag(token, argv[cursor + 1]);
    if (match === undefined || !isLandoOwned(match)) break;
    const value = argv[cursor + 1];
    globalEntries.push({
      index: cursor,
      tokens: [token, ...(match.consumed === 1 && value !== undefined ? [value] : [])],
    });
    cursor += 1 + match.consumed;
  }

  // Normalization returns one id followed by the words it did not join.
  const normalized = normalizeCompiledCommandArgv(words);
  const consumedWords = words.length - (normalized.length - 1);
  const commandWordTokens = commandWordIndices.slice(0, consumedWords);
  const lastIndex = commandWordTokens.at(-1) ?? index;
  const commandId = normalized[0] ?? words[0];
  return {
    commandEndIndex: lastIndex,
    commandWordIndices: commandWordTokens,
    ...(commandId === undefined ? {} : { commandId }),
    // Only flags before the resolved command name are the lead's; tokens the
    // words scan skipped past the name belong to the command region.
    headGlobals: [
      ...headGlobals,
      ...globalEntries.filter((entry) => entry.index < lastIndex).flatMap((entry) => entry.tokens),
    ],
  };
};

export interface InvocationSplit {
  /** Lando-owned stripped tokens, in original typed order (flag plus its value). */
  readonly globals: ReadonlyArray<string>;
  /** Every other token in original order, with the normalized command id first when there is one. */
  readonly argv: ReadonlyArray<string>;
  /** How many trailing `argv` tokens are the command's verbatim tail. */
  readonly tailLength: number;
}

const declaredFlagFor = (
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

export const splitInvocation = (
  argv: ReadonlyArray<string>,
  head: InvocationHead,
  policy: TailPolicy,
): InvocationSplit => {
  const globals: string[] = [];
  const command: string[] = [];
  const commandWords = new Set(head.commandWordIndices);
  const commandFlags = policy.kind === "command" ? flagDefinitionsByToken(policy.flags) : undefined;
  let emittedCommand = false;
  let landoReading = true;
  let tailStarted = false;
  let tailLength = 0;
  // `commandTailIndex` prefers the first `--` anywhere over the first positional,
  // so exec's service-before-the-separator form keeps its boundary.
  let commandTailStart = -1;
  if (policy.kind === "command") {
    for (let cursor = head.commandEndIndex + 1; cursor < argv.length; cursor += 1) {
      if (argv[cursor] === "--") {
        commandTailStart = cursor;
        break;
      }
    }
  }

  const pushCommand = (token: string, isTail: boolean): void => {
    command.push(token);
    if (isTail) tailLength += 1;
  };

  const takeTableFlag = (token: string, next: string | undefined): number | undefined => {
    const match = matchLandoFlag(token, next);
    if (match === undefined) return undefined;
    if (isLandoOwned(match)) {
      globals.push(token);
      if (match.consumed === 1 && next !== undefined) globals.push(next);
    } else {
      command.push(token);
    }
    return 1 + match.consumed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (commandWords.has(index)) {
      if (!emittedCommand && head.commandId !== undefined) {
        command.push(head.commandId);
        emittedCommand = true;
      }
      continue;
    }

    if (!landoReading) {
      pushCommand(token, tailStarted);
      continue;
    }

    if (head.commandId === undefined || index <= head.commandEndIndex) {
      if (token === "--") {
        landoReading = false;
        command.push(token);
        continue;
      }
      const consumed = takeTableFlag(token, argv[index + 1]);
      if (consumed !== undefined) {
        index += consumed - 1;
        continue;
      }
      command.push(token);
      continue;
    }

    if (tailStarted) {
      pushCommand(token, true);
      continue;
    }

    switch (policy.kind) {
      case "none": {
        if (token === "--") {
          landoReading = false;
          command.push(token);
          continue;
        }
        const consumed = takeTableFlag(token, argv[index + 1]);
        if (consumed !== undefined) {
          index += consumed - 1;
          continue;
        }
        command.push(token);
        continue;
      }
      case "all": {
        tailStarted = true;
        pushCommand(token, true);
        continue;
      }
      case "declared": {
        if (token === "--") {
          landoReading = false;
          command.push(token);
          continue;
        }
        const declared = declaredFlagFor(token, policy.flags);
        if (declared !== undefined) {
          command.push(token);
          const value = argv[index + 1];
          // The adjacent token is this flag's value slot. A flag-shaped token there is a
          // missing value for the task's binder to report, never one of Lando's flags.
          if (!declared.boolean && !token.includes("=") && value !== undefined && value !== "--") {
            command.push(value);
            index += 1;
          }
          continue;
        }
        const consumed = takeTableFlag(token, argv[index + 1]);
        if (consumed !== undefined) {
          index += consumed - 1;
          continue;
        }
        command.push(token);
        continue;
      }
      case "command": {
        if (index === commandTailStart) {
          tailStarted = true;
          landoReading = false;
          pushCommand(token, true);
          continue;
        }
        const consumed = takeTableFlag(token, argv[index + 1]);
        if (consumed !== undefined) {
          index += consumed - 1;
          continue;
        }
        if (commandTailStart === -1 && (!token.startsWith("-") || token === "-")) {
          tailStarted = true;
          pushCommand(token, true);
          continue;
        }
        command.push(token);
        const next = argv[index + 1];
        if (next !== undefined && commandFlagTakesNext(token, next, policy.flags, commandFlags)) {
          command.push(next);
          index += 1;
        }
        continue;
      }
      default:
        return policy satisfies never;
    }
  }

  return { globals, argv: command, tailLength };
};
