import type { BunShellDialectIssue } from "./bun-shell-dialect.ts";

const SCRIPT =
  "Put loops and functions in a script you run by path, such as bash ./scripts/task.sh on macOS and Linux, or bun ./task.ts on any platform.";
const RESERVED = new Set(["for", "while", "until", "case", "select", "function", "{", "!"]);
const COMMAND_AFTER = new Set(["if", "then", "elif", "else", "do", "fi"]);
const BUILTINS = new Set([
  "set",
  "unset",
  "source",
  ".",
  "eval",
  "exec",
  "shift",
  "trap",
  "wait",
  "local",
  "read",
  "readonly",
  "return",
  "getopts",
  "alias",
  "unalias",
  "umask",
  "ulimit",
  "type",
  "command",
  "hash",
  "break",
  "continue",
  ":",
]);

const commandSuggestion = (word: string): string => {
  switch (word) {
    case "{":
      return "Group commands with ( ... ) instead.";
    case "!":
      return "Act on failure with command || other, or if command; then ... fi.";
    case "command":
    case "type":
    case "hash":
      return "Use which NAME to find a program.";
    case "set":
      return "Chain commands with && to stop at the first failure.";
    case "source":
    case ".":
      return "Pass values through the task's env: instead of loading a shell file.";
    case ":":
      return "Write true instead.";
    default:
      return SCRIPT;
  }
};

/** The word after quote removal, or undefined when an expansion makes it unknown until it runs. */
const withoutQuotes = (word: string): string | undefined => {
  if (/[$`]/u.test(word)) return undefined;
  let text = "";
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index] as string;
    if (char === "\\") {
      text += word[index + 1] ?? "";
      index += 1;
    } else if (char === "'" || char === '"') {
      const close = word.indexOf(char, index + 1);
      if (close === -1) return undefined;
      const quoted = word.slice(index + 1, close);
      text += char === '"' ? quoted.replace(/\\(.)/gsu, "$1") : quoted;
      index = close;
    } else text += char;
  }
  return text;
};

const builtinIssue = (index: number, text: string, name: string): BunShellDialectIssue => ({
  index,
  text,
  message: `Bun Shell has no ${name} builtin; it would report the command as not found and keep going.`,
  suggestion: commandSuggestion(name),
  ...(name === ":" ? { replacement: "true" } : {}),
});

/** Word classification for one lexer frame; substitutions get their own instance. */
export class BunShellCommandPosition {
  private word: { readonly start: number; quoted: boolean } | undefined;
  private command = true;
  private redirectTarget = false;
  private readonly groups: boolean[] = [];
  groupClosed = false;

  constructor(
    private readonly source: string,
    private readonly issues: BunShellDialectIssue[],
  ) {}

  begin(index: number, quoted = false): void {
    this.word ??= { start: index, quoted };
    this.word.quoted ||= quoted;
  }

  finish(index: number): void {
    const token = this.word;
    if (token === undefined) return;
    this.word = undefined;
    if (this.redirectTarget) {
      this.redirectTarget = false;
      return;
    }
    const word = this.source.slice(token.start, index);
    if (this.command && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) return;
    const command = this.command;
    this.command = false;
    if (!command) return;
    if (token.quoted) {
      // Quotes keep a reserved word from being a keyword, but a quoted builtin name still runs it.
      const name = withoutQuotes(word);
      if (name !== undefined && BUILTINS.has(name)) this.issues.push(builtinIssue(token.start, word, name));
      return;
    }
    const definition = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word)
      ? /^[ \t]*\([ \t]*\)/u.exec(this.source.slice(index))?.[0]
      : undefined;
    if (definition !== undefined) {
      const text = word + definition;
      this.issues.push({
        index: token.start,
        text,
        message: `Bun Shell does not support function definitions such as ${text}.`,
        suggestion: SCRIPT,
      });
    } else if (RESERVED.has(word)) {
      this.issues.push({
        index: token.start,
        text: word,
        message: `Bun Shell does not support ${word} as a command.`,
        suggestion: commandSuggestion(word),
      });
    } else if (BUILTINS.has(word)) {
      this.issues.push(builtinIssue(token.start, word, word));
    } else if (COMMAND_AFTER.has(word)) this.command = true;
  }

  redirect(needsTarget: boolean): void {
    this.redirectTarget = needsTarget;
  }

  escape(index: number, inWord: boolean): void {
    if (this.source[index + 1] !== "\n") {
      this.begin(index, true);
      return;
    }
    if (
      inWord &&
      !/[\s;|&()<>]/u.test(this.source[index - 1] ?? "") &&
      this.source[index + 2] !== undefined &&
      !/\s/u.test(this.source[index + 2] ?? "")
    )
      this.issues.push({
        index,
        text: "\\\n",
        message: "Bun Shell splits a word at a backslash-newline, where sh joins it.",
        suggestion: "Keep the word on one line.",
      });
    this.finish(index);
  }

  separator(): void {
    this.command = true;
    this.redirectTarget = false;
    this.groupClosed = false;
  }

  parenthesis(char: string): void {
    if (char === "(") {
      this.groups.push(this.command);
      this.separator();
    } else {
      this.groupClosed = this.groups.pop() === true;
      this.command = false;
      this.redirectTarget = false;
    }
  }
}
