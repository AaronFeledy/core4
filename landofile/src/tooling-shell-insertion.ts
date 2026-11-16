/**
 * Shell position naming what a value inserted at the end of scanned text would
 * land in. `unquoted`, `single`, and `double` are the insertion-safe
 * positions; every other name describes a position where inserting generated
 * shell text would change the authored program.
 */
export type SafeShellInsertion = "unquoted" | "single" | "double";

export type ShellInsertion =
  | "unquoted"
  | "single"
  | "double"
  | "comment"
  | "heredoc"
  | "backtick"
  | "parameter"
  | "arithmetic"
  | "dollar-quote"
  | "case"
  | "escaped";

const INSERTION_REFUSALS: Readonly<
  Record<Exclude<ShellInsertion, "unquoted" | "single" | "double">, string>
> = {
  comment: "a shell comment",
  heredoc: "a here-document",
  backtick: "a backtick command substitution",
  parameter: "a `${...}` parameter expansion",
  arithmetic: "a `$((...))` arithmetic expansion",
  "dollar-quote": "a `$'...'` or `$\"...\"` quoted string",
  case: "a `case` statement",
  escaped: "an escaped reference",
};

/** Plain-word refusal for an unsafe insertion point, or undefined when it is safe. */
export const shellInsertionRefusal = (insertion: ShellInsertion): string | undefined =>
  isSafeShellInsertion(insertion) ? undefined : INSERTION_REFUSALS[insertion];

export const isSafeShellInsertion = (insertion: ShellInsertion): insertion is SafeShellInsertion =>
  insertion === "unquoted" || insertion === "single" || insertion === "double";
