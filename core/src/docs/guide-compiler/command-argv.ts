import { Result, Schema } from "effect";

/**
 * A guide command string with no single shell-word reading. `unterminated-quote` and
 * `dangling-escape` are malformed quoting; `shell-syntax` is unquoted text that a reader's
 * shell would interpret (an operator, expansion, command separator, or leading variable
 * assignment) instead of passing on; `empty-command` names no command at all.
 */
export class GuideCommandSyntaxError extends Schema.TaggedError<GuideCommandSyntaxError>()(
  "GuideCommandSyntaxError",
  {
    message: Schema.String,
    command: Schema.String,
    reason: Schema.Literals(["unterminated-quote", "dangling-escape", "shell-syntax", "empty-command"]),
    /** Zero-based offset into the command string. */
    index: Schema.Number,
    /** The offending character, or the opening quote for an unterminated quote. */
    character: Schema.String,
    remediation: Schema.String,
  },
) {}

const REMEDIATION =
  "Quote the argument the way a POSIX shell needs it: close every quote, and wrap operators, redirections, $ or backtick substitution, globs, braces, !, and a leading ~ or # in single quotes. Guide commands run as the argv a reader gets by pasting them into a shell.";

const WORD_SEPARATORS = new Set([" ", "\t"]);
// Unquoted, these separate commands or start operators, redirections, substitutions, globs,
// history or brace expansion, so a reader's shell would not pass the literal text as argv.
const SHELL_SYNTAX = new Set([
  "\n",
  "\r",
  "\0",
  "|",
  "&",
  ";",
  "<",
  ">",
  "(",
  ")",
  "$",
  "`",
  "*",
  "?",
  "[",
  "{",
  "}",
  "!",
]);
// Special only at the start of a word: tilde expansion and comments.
const WORD_START_SYNTAX = new Set(["~", "#"]);
// Inside double quotes a backslash escapes only these; it is literal before anything else.
const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

const describe = (
  command: string,
  reason: GuideCommandSyntaxError["reason"],
  index: number,
  character: string,
): string => {
  const at = `at offset ${index} of the guide command`;
  switch (reason) {
    case "unterminated-quote":
      return `Unterminated ${character === "'" ? "single" : "double"} quote ${at}: ${command}`;
    case "dangling-escape":
      return `Trailing backslash with nothing to escape ${at}: ${command}`;
    case "shell-syntax":
      return `Unquoted shell syntax ${JSON.stringify(character)} ${at}; a shell would interpret it instead of passing it as an argument: ${command}`;
    case "empty-command":
      return "The guide command is empty.";
  }
};

/**
 * Splits a guide command into the argv a POSIX shell gives it, without running a shell.
 * Words are separated by unquoted spaces and tabs and may concatenate quoted and unquoted
 * parts. Single quotes are literal, double quotes honor the POSIX backslash escapes, an
 * unquoted backslash escapes the next character, a backslash-newline is removed, and quoted
 * empty strings are kept. Anything a shell would interpret (command separators, operators,
 * redirections, `$` or backtick substitution, globs, braces, `!`, and a word-initial `~` or
 * `#`) is rejected unless quoted or escaped, as are a leading `NAME=value` assignment and an
 * empty command, so the argv matches what a reader gets by pasting the command into bash, zsh,
 * or another POSIX-style shell.
 */
export const guideCommandArgv = (
  command: string,
): Result.Result<ReadonlyArray<string>, GuideCommandSyntaxError> => {
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  let index = 0;
  const fail = (reason: GuideCommandSyntaxError["reason"], at: number) => {
    const character = command[at] ?? "";
    return Result.fail(
      new GuideCommandSyntaxError({
        message: describe(command, reason, at, character),
        command,
        reason,
        index: at,
        character,
        remediation: REMEDIATION,
      }),
    );
  };
  // A leading unquoted NAME=value word is an environment assignment, not the command.
  const assignment = /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=/.exec(command);
  if (assignment !== null) return fail("shell-syntax", assignment[0].length - 1);
  while (index < command.length) {
    const char = command.charAt(index);
    if (char === "\\" && command[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (WORD_SEPARATORS.has(char)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) return fail("unterminated-quote", index);
      const nul = command.indexOf("\0", index + 1);
      if (nul !== -1 && nul < close) return fail("shell-syntax", nul);
      word += command.slice(index + 1, close);
      inWord = true;
      index = close + 1;
      continue;
    }
    if (char === '"') {
      const open = index;
      index += 1;
      let closed = false;
      while (index < command.length) {
        const inner = command.charAt(index);
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "\\") {
          const next = command[index + 1];
          if (next === undefined) return fail("unterminated-quote", open);
          if (DOUBLE_QUOTE_ESCAPES.has(next)) {
            if (next !== "\n") word += next;
            index += 2;
            continue;
          }
        }
        if (inner === "$" || inner === "`" || inner === "\0") return fail("shell-syntax", index);
        word += inner;
        index += 1;
      }
      if (!closed) return fail("unterminated-quote", open);
      inWord = true;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) return fail("dangling-escape", index);
      if (next === "\0") return fail("shell-syntax", index + 1);
      word += next;
      inWord = true;
      index += 2;
      continue;
    }
    if (SHELL_SYNTAX.has(char) || (!inWord && WORD_START_SYNTAX.has(char))) {
      return fail("shell-syntax", index);
    }
    word += char;
    inWord = true;
    index += 1;
  }
  if (inWord) argv.push(word);
  return argv.length === 0 ? fail("empty-command", 0) : Result.succeed(argv);
};
