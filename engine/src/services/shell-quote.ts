/**
 * Single-source shell quoting helpers.
 *
 * Centralising this avoids drifting escape rules between callers — see PR #95
 * Bugbot follow-up. Any future quoting edge cases (e.g. CR/LF, NUL bytes) must
 * be fixed here once.
 */

import { sep } from "node:path";

/**
 * POSIX single-quote escape: wraps the input in `'…'`, with each embedded
 * single quote replaced by `'\''`. Safe to splice into a `/bin/sh`-compatible
 * command line where no parameter expansion is desired.
 */
export const quoteShellPath = (target: string): string => `'${target.replaceAll("'", `'\\''`)}'`;

/**
 * A copy-pasteable argument for the host's shell: bare when it has no metacharacters. Otherwise
 * POSIX single-quoted; on Windows double-quoted, which cmd.exe and PowerShell both accept (a path
 * can never contain `"`), unless it holds `$` or a backtick, which PowerShell would expand inside
 * double quotes, so it gets PowerShell single quotes instead.
 */
export const shellArg = (
  value: string,
  shell: "posix" | "windows" = sep === "\\" ? "windows" : "posix",
): string => {
  if (shell === "windows") {
    if (/^[a-zA-Z0-9_.\\/:@+=-]+$/.test(value)) return value;
    return /[$`]/.test(value) ? `'${value.replaceAll("'", "''")}'` : `"${value}"`;
  }
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : quoteShellPath(value);
};
