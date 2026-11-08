import { flagDefinitionsByToken, normalizeCliFlagTokens } from "./flag-tokens";
import { isSpaceFormJsonFieldList } from "./format-flags";

/** How many following tokens a dispatcher-owned flag takes when its value is not attached with `=`. */
type DispatcherFlagValue = "none" | "required" | ((next: string) => boolean);

/**
 * Flags the dispatcher reads before any command sees argv. A command tail must
 * not start at one of their values, so the boundary walk skips them too.
 */
const DISPATCHER_FLAGS: ReadonlyMap<string, DispatcherFlagValue> = new Map<string, DispatcherFlagValue>([
  ["--trace", "none"],
  ["--debug", "none"],
  ["--verbose", "none"],
  ["--log-level", "required"],
  ["--renderer", "required"],
  ["--no-deprecation-warnings", "none"],
  ["--format", "required"],
  ["--json", isSpaceFormJsonFieldList],
  ["-j", "none"],
  ["--jq", "required"],
  ["--help", "none"],
  ["-h", "none"],
  ["--version", "none"],
  ["-v", "none"],
  ["--expand", "none"],
  ["--no-expand", "none"],
  ["--collapse", "none"],
  ["--no-collapse", "none"],
  ["--tail", "none"],
  ["--no-tail", "none"],
]);

const dispatcherFlagTakesNext = (arg: string, next: string | undefined): boolean => {
  if (arg.includes("=") || next === undefined || next === "--" || next.startsWith("-")) return false;
  const value = DISPATCHER_FLAGS.get(arg);
  return value === "required" || (typeof value === "function" && value(next));
};

/**
 * Index of the first command word: a `--`, a bare `-`, or the first token that
 * is not a flag or a declared flag's value. With `dispatcherFlags`, the
 * dispatcher's own flags and their values are skipped too.
 */
export const firstCommandWordIndex = (
  argv: ReadonlyArray<string>,
  definitions: Readonly<Record<string, unknown>>,
  options: { readonly dispatcherFlags?: boolean } = {},
): number => {
  const byToken = flagDefinitionsByToken(definitions);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--" || arg === "-" || !arg.startsWith("-")) return index;
    const name = arg.split("=", 1)[0] ?? arg;
    if (options.dispatcherFlags === true && !byToken.has(name) && DISPATCHER_FLAGS.has(name)) {
      if (dispatcherFlagTakesNext(arg, argv[index + 1])) index += 1;
      continue;
    }
    const normalized = normalizeCliFlagTokens([arg], definitions);
    const last = normalized.at(-1);
    if (last === undefined || last.includes("=")) continue;
    const definition = byToken.get(last);
    if (definition !== undefined && !definition.boolean && argv[index + 1] !== "--") index += 1;
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
  options: { readonly dispatcherFlags?: boolean } = {},
): number => {
  const separator = argv.indexOf("--");
  return separator === -1 ? firstCommandWordIndex(argv, definitions, options) : separator;
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
