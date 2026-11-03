/**
 * Finds POSIX shell constructs that Lando's embedded Bun Shell leaves as literal text or
 * cannot parse, so host commands fail with a positioned fix instead of running wrong.
 * The rules mirror Bun Shell's lexer; `bun-shell-dialect-conformance.test.ts` proves each
 * divergence against the embedded Bun and fails when an upgrade closes one, which is the cue to
 * delete that rule. Upstream: oven-sh/bun#46691 (`${NAME}`), #45490 (`$?`, `$$`), #46108
 * (unclosed quotes), #44532 and #43922 (here-documents), #25669 (several redirections),
 * #47822 (`>&2`), #47823 (a distinct status for parse failures).
 */

import { isDigit, readRedirection } from "./bun-shell-redirection.ts";

export interface BunShellDialectIssue {
  /** UTF-16 offset of the construct in the scanned text. */
  readonly index: number;
  /** The construct as written, such as `${DEPLOY_TOKEN}`, `>&2`, or `$?`. */
  readonly text: string;
  readonly message: string;
  readonly suggestion: string;
  /** Text that replaces `text` with the same meaning, when the fix is mechanical. */
  readonly replacement?: string;
}

export interface BunShellDialectOptions {
  /** `"allow"` for `.bun.sh` files, where Bun Shell binds `$0` through `$9`. Defaults to `"reject"`. */
  readonly positional?: "reject" | "allow";
}

interface Frame {
  /** `top` is the whole command, `paren` a `$(...)` body, `backtick` a `` `...` `` body. */
  readonly kind: "top" | "paren" | "backtick";
  /** Offset of the open double quote when the frame is inside one. */
  double: number | undefined;
  /** Unmatched `(` inside this frame, so its own closing `)` is told apart. */
  parens: number;
  /** Redirections seen on the current simple command. */
  redirections: number;
  /** Whether the next character continues a word (a `#` there is not a comment). */
  inWord: boolean;
}

const FORWARDED = "Remove it. Lando appends forwarded arguments to the end of a host command.";
const SCRIPT_ARGUMENTS =
  "Name each argument with $1 through $9, or read declared inputs from LANDO_FLAG_*, LANDO_ARG_*, or LANDO_INPUT.";
const SPECIAL_PARAMETERS = new Set(["?", "#", "@", "*", "$", "!", "-"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const isNameStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z_]/u.test(char);
const isNameChar = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/u.test(char);

/** Scans host shell text and returns every unsupported construct in source order. */
export const bunShellDialectIssues = (
  source: string,
  options?: BunShellDialectOptions,
): ReadonlyArray<BunShellDialectIssue> => {
  const allowPositional = options?.positional === "allow";
  const issues: BunShellDialectIssue[] = [];
  const report = (at: number, text: string, message: string, suggestion: string, replacement?: string) =>
    issues.push({
      index: at,
      text,
      message,
      suggestion,
      ...(replacement === undefined ? {} : { replacement }),
    });
  const frames: Frame[] = [];
  const push = (kind: Frame["kind"]) =>
    frames.push({ kind, double: undefined, parens: 0, redirections: 0, inWord: false });
  push("top");
  let index = 0;

  /** Handles `$` at `index` and returns the offset after the expansion it starts. */
  const expansion = (): number => {
    const next = source[index + 1];
    if (next === "{") {
      let end = index + 2;
      while (end < source.length && source[end] !== "}") end += source[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, source.length);
      const text = source.slice(index, end);
      const body = text.endsWith("}") ? text.slice(2, -1) : text.slice(2);
      if (IDENTIFIER.test(body))
        report(
          index,
          text,
          `Bun Shell does not expand ${text}.`,
          `Write $${body}, or "$${body}" when a letter, digit, or underscore follows it.`,
          // `${NAME}x` would become `$NAMEx`, a different variable, so only a clean boundary is mechanical.
          text.endsWith("}") && !isNameChar(source[end]) ? `$${body}` : undefined,
        );
      else
        report(
          index,
          text,
          "Bun Shell does not support ${...} parameter expansion such as ${NAME:-default}.",
          "Write $NAME and set a default through env:.",
        );
      return end;
    }
    if (next === "(" && source[index + 2] === "(") {
      let depth = 0;
      let end = index + 1;
      do {
        if (source[end] === "(") depth += 1;
        else if (source[end] === ")") depth -= 1;
        end += 1;
      } while (end < source.length && depth > 0);
      report(
        index,
        "$((",
        "Bun Shell has no $((...)) arithmetic.",
        'Compute the value with bun, for example $(bun -e "console.log(1 + 2)").',
      );
      return end;
    }
    if (next === "(") {
      push("paren");
      return index + 2;
    }
    if (next !== undefined && SPECIAL_PARAMETERS.has(next)) {
      const text = `$${next}`;
      const message = `Bun Shell does not expand ${text}.`;
      if (next === "?") report(index, text, message, "Branch on the exit status with && or || instead.");
      else if (next === "@" || next === "#" || next === "*")
        report(index, text, message, allowPositional ? SCRIPT_ARGUMENTS : FORWARDED);
      else report(index, text, message, "Remove it.");
      return index + 2;
    }
    if (isDigit(next)) {
      if (!allowPositional)
        report(
          index,
          `$${next}`,
          `$${next} is not bound to forwarded arguments in a host command.`,
          FORWARDED,
        );
      return index + 2;
    }
    let end = index + 1;
    if (isNameStart(next)) while (isNameChar(source[end])) end += 1;
    return end;
  };

  while (index < source.length) {
    const frame = frames.at(-1) as Frame;
    const char = source[index] as string;

    if (frame.double !== undefined) {
      if (char === "\\") index += 2;
      else if (char === '"') {
        frame.double = undefined;
        index += 1;
      } else if (char === "$") index = expansion();
      else if (char === "`") {
        push("backtick");
        index += 1;
      } else index += 1;
      continue;
    }

    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      if (close === -1) {
        report(index, "'", "This ' quote is never closed.", "Close the quote.");
        break;
      }
      frame.inWord = true;
      index = close + 1;
      continue;
    }
    if (char === '"') {
      frame.double = index;
      frame.inWord = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      frame.inWord = source[index + 1] !== "\n";
      index += 2;
      continue;
    }
    // Bun Shell starts a comment only at a `#` that begins the text or follows whitespace.
    if (char === "#" && !frame.inWord && (index === 0 || /\s/u.test(source[index - 1] ?? ""))) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      if (char === "\n") frame.redirections = 0;
      frame.inWord = false;
      index += 1;
      continue;
    }
    if (char === "`") {
      if (frame.kind === "backtick") frames.pop();
      else push("backtick");
      index += 1;
      continue;
    }
    if (char === ")" && frame.kind === "paren" && frame.parens === 0) {
      frames.pop();
      index += 1;
      continue;
    }
    if (char === "(" || char === ")") {
      frame.parens += char === "(" ? 1 : frame.parens > 0 ? -1 : 0;
      frame.redirections = 0;
      frame.inWord = false;
      index += 1;
      continue;
    }

    const redirection = readRedirection(source, index);
    if (redirection !== undefined) {
      const text = source.slice(index, redirection.end);
      frame.redirections += 1;
      if (redirection.kind === "issue")
        report(index, text, redirection.message, redirection.suggestion, redirection.replacement);
      else if (frame.redirections > 1)
        report(
          index,
          text,
          `Bun Shell accepts one redirection per command, and ${text} is a second one.`,
          "Write &>file or &>>file to send stdout and stderr to one file, or split the command.",
        );
      frame.inWord = false;
      index = redirection.end;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      frame.redirections = 0;
      frame.inWord = false;
      index += source[index + 1] === char ? 2 : 1;
      continue;
    }
    if (char === "$") {
      frame.inWord = true;
      index = expansion();
      continue;
    }
    frame.inWord = true;
    index += 1;
  }

  for (const frame of frames)
    if (frame.double !== undefined)
      report(frame.double, '"', 'This " quote is never closed.', "Close the quote.");
  return issues.sort((left, right) => left.index - right.index);
};

/** The first issue in a Bun Shell script file, with its 1-based line and column. */
export const bunShellScriptIssue = (
  source: string,
): (BunShellDialectIssue & { readonly line: number; readonly column: number }) | undefined => {
  const issue = bunShellDialectIssues(source, { positional: "allow" })[0];
  if (issue === undefined) return undefined;
  const before = source.slice(0, issue.index);
  return { ...issue, line: before.split("\n").length, column: issue.index - before.lastIndexOf("\n") };
};

/**
 * The command with every issue's mechanical replacement applied, when that leaves nothing for Bun
 * Shell to misread. Undefined when the text is already clean or any issue needs a person to decide.
 */
export const correctedBunShellText = (
  source: string,
  options?: BunShellDialectOptions,
): string | undefined => {
  const issues = bunShellDialectIssues(source, options);
  if (issues.length === 0 || issues.some((issue) => issue.replacement === undefined)) return undefined;
  const corrected = applyBunShellReplacements(source, issues);
  return bunShellDialectIssues(corrected, options).length === 0 ? corrected : undefined;
};

/** Applies each issue's replacement at its offset; text the issues didn't cover is untouched. */
export const applyBunShellReplacements = (
  source: string,
  issues: ReadonlyArray<BunShellDialectIssue>,
): string => {
  let text = source;
  for (const issue of [...issues].sort((left, right) => right.index - left.index))
    if (issue.replacement !== undefined)
      text = `${text.slice(0, issue.index)}${issue.replacement}${text.slice(issue.index + issue.text.length)}`;
  return text;
};

/** `Column N: <message>`, the one-line form every host-shell diagnostic uses. */
export const describeBunShellIssue = (issue: BunShellDialectIssue): string =>
  `Column ${issue.index + 1}: ${issue.message}`;
