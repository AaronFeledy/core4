import { flagDefinitionsByToken } from "./flag-tokens";
import { commandFlagTakesNext } from "./invocation";

/**
 * Index of the first command word: a `--`, a bare `-`, or the first token that
 * is not a flag or a declared flag's value.
 */
export const firstCommandWordIndex = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): number => {
  const byToken = flagDefinitionsByToken(definitions);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) return index;
    if (commandFlagTakesNext(arg, argv[index + 1], definitions, byToken)) index += 1;
  }
  return argv.length;
};

/**
 * Index where a command's verbatim tail starts: the first `--` the user typed,
 * otherwise the first command word. Tokens before it are Lando's to parse.
 */
export const commandTailIndex = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): number => {
  const separator = argv.indexOf("--");
  return separator === -1 ? firstCommandWordIndex(argv, definitions) : separator;
};

/** How many command words precede the first `--`, or -1 when there is none. */
export const wordsBeforeSeparator = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): number => {
  const separator = argv.indexOf("--");
  if (separator === -1) return -1;
  let words = 0;
  for (let index = 0; index < separator; ) {
    const word = index + firstCommandWordIndex(argv.slice(index, separator), definitions);
    if (word >= separator) break;
    words += 1;
    index = word + 1;
  }
  return words;
};

export const withCommandRemainderSeparator = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const index = commandTailIndex(argv, definitions);
  if (index === argv.length || argv[index] === "--") return argv;
  return [...argv.slice(0, index), "--", ...argv.slice(index)];
};
