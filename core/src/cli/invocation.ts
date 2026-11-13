import { normalizeCompiledCommandArgv } from "./compiled-normalize";
import {
  type LandoFlagEntry,
  type LandoFlagMatch,
  type LandoFlagSpelling,
  landoControlRole,
  matchLandoFlag,
} from "./lando-flags";

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

export interface CommandClaim {
  /** Whether the flag takes the adjacent token as its value. */
  readonly takesNext: boolean;
}

/**
 * How one owner reads the tokens after its command name. `reservedOutput` is
 * data, not an owner-kind check: the built-in and plugin policies reserve the
 * output spellings before any definition can claim them.
 */
export interface OwnerPolicy {
  readonly tail: "none" | "command" | "all";
  /** Whether the command declares the flag `token` spells, and whether it takes the adjacent token. */
  readonly claims: (token: string, next: string | undefined) => CommandClaim | undefined;
  /** Table spellings the walker gives Lando before asking claims. */
  readonly reservedOutput: ReadonlyArray<LandoFlagSpelling>;
}

/** A command's own tokens, in typed order, with Lando's removed. */
export interface CommandTokens {
  readonly argv: ReadonlyArray<string>;
  /** Index in `argv` where the verbatim tail starts, or the `--` that ends Lando's reading; `argv.length` when there is neither. */
  readonly tailStart: number;
}

export interface TokenSplit {
  /** Lando's selection tokens (flag plus value) in typed order. */
  readonly globals: ReadonlyArray<string>;
  /** Lando's own help and version flags as typed, in order. They are in neither `globals` nor `command`. */
  readonly controls: ReadonlyArray<string>;
  readonly help: boolean;
  readonly version: boolean;
  readonly command: CommandTokens;
}

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
 * command word means there is no owner: the dispatcher fails on the first token.
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

export interface InvocationSplit extends TokenSplit {
  /** The subset of `globals` typed after the command name, for owner-aware errors. */
  readonly globalsAfterName: ReadonlyArray<string>;
}

const isLandoOwned = (match: LandoFlagMatch): boolean =>
  match.flag.role === "selection" || match.flag.role === "reserved";

const inScope = (flag: LandoFlagEntry, lando: "all" | "output" | "none"): boolean =>
  lando === "all" || (lando === "output" && flag.output === true);

/** Push a Lando-owned occurrence and, when it consumed one, its adjacent value. */
const pushOwned = (
  target: string[],
  tokens: ReadonlyArray<string>,
  index: number,
  token: string,
  consumed: 0 | 1,
): void => {
  target.push(token);
  const value = tokens[index + 1];
  if (consumed === 1 && value !== undefined) target.push(value);
};

const requestsHelp = (controls: ReadonlyArray<string>): boolean =>
  controls.some((control) => landoControlRole(control) === "help");

const requestsVersion = (controls: ReadonlyArray<string>): boolean =>
  controls.some((control) => landoControlRole(control) === "version");

const collectTokens = (tokens: ReadonlyArray<string>): string[] => {
  const collected: string[] = [];
  for (const token of tokens) if (token !== undefined) collected.push(token);
  return collected;
};

/**
 * Classify the tokens typed after a command name. `lando` selects which table
 * flags are read: "all" for the dispatcher, "output" (only output flags) and
 * "none" for callers that have no dispatcher to act on the rest.
 */
export const splitCommandTokens = (
  tokens: ReadonlyArray<string>,
  policy: OwnerPolicy,
  lando: "all" | "output" | "none" = "all",
): TokenSplit => {
  if (policy.tail === "all") {
    return {
      globals: [],
      controls: [],
      help: false,
      version: false,
      command: { argv: collectTokens(tokens), tailStart: 0 },
    };
  }

  const hasSeparator = policy.tail === "command" && tokens.includes("--");
  const reservedOutput = new Set(policy.reservedOutput);
  const globals: string[] = [];
  const controls: string[] = [];
  const argv: string[] = [];
  let tailStart = -1;

  const takeTail = (from: number): void => {
    tailStart = argv.length;
    for (let index = from; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token !== undefined) argv.push(token);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--") {
      takeTail(index);
      break;
    }

    const match = lando === "none" ? undefined : matchLandoFlag(token, tokens[index + 1]);
    if (match !== undefined && reservedOutput.has(match.flag.spelling)) {
      pushOwned(globals, tokens, index, token, match.consumed);
      index += match.consumed;
      continue;
    }

    const claim = policy.claims(token, tokens[index + 1]);
    if (claim !== undefined) {
      argv.push(token);
      if (claim.takesNext) {
        const value = tokens[index + 1];
        if (value !== undefined) {
          argv.push(value);
          index += 1;
        }
      }
      continue;
    }

    if (match !== undefined && inScope(match.flag, lando)) {
      if (match.flag.role === "help" || match.flag.role === "version") controls.push(token);
      else pushOwned(globals, tokens, index, token, match.consumed);
      index += match.consumed;
      continue;
    }

    // A typed `--` wins over the first positional, so exec's
    // service-before-the-separator form keeps its boundary.
    if (policy.tail === "command" && !hasSeparator && (token === "-" || !token.startsWith("-"))) {
      takeTail(index);
      break;
    }
    argv.push(token);
  }

  return {
    globals,
    controls,
    help: requestsHelp(controls),
    version: requestsVersion(controls),
    command: { argv, tailStart: tailStart === -1 ? argv.length : tailStart },
  };
};

/**
 * Split the whole invocation: the tokens up to and between command words are
 * classified from the table (`--` terminates, help and version end the head
 * scan), and everything after the command name is delegated to
 * `splitCommandTokens`.
 */
export const splitInvocation = (
  argv: ReadonlyArray<string>,
  head: InvocationHead,
  policy: OwnerPolicy,
): InvocationSplit => {
  const globals: string[] = [];
  const controls: string[] = [];
  const preCommand: string[] = [];
  const commandWords = new Set(head.commandWordIndices);
  let landoReading = true;
  let index = 0;

  while (index < argv.length && index <= head.commandEndIndex) {
    const token = argv[index];
    if (token === undefined) {
      index += 1;
      continue;
    }
    if (commandWords.has(index)) {
      index += 1;
      continue;
    }
    if (!landoReading) {
      preCommand.push(token);
      index += 1;
      continue;
    }
    if (token === "--") {
      landoReading = false;
      preCommand.push(token);
      index += 1;
      continue;
    }
    const match = matchLandoFlag(token, argv[index + 1]);
    if (match !== undefined && isLandoOwned(match)) {
      pushOwned(globals, argv, index, token, match.consumed);
      index += 1 + match.consumed;
      continue;
    }
    if (match !== undefined) {
      controls.push(token);
      index += 1;
      continue;
    }
    preCommand.push(token);
    index += 1;
  }

  const afterName = splitCommandTokens(argv.slice(index), policy);
  const allControls = [...controls, ...afterName.controls];
  return {
    globals: [...globals, ...afterName.globals],
    controls: allControls,
    help: requestsHelp(allControls),
    version: requestsVersion(allControls),
    command: {
      argv: [...preCommand, ...afterName.command.argv],
      tailStart: preCommand.length + afterName.command.tailStart,
    },
    globalsAfterName: afterName.globals,
  };
};
