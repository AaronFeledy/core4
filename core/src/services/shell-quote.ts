/**
 * Single-source shell quoting helpers.
 *
 * Centralising this avoids drifting escape rules between callers — see PR #95
 * Bugbot follow-up. Any future quoting edge cases (e.g. CR/LF, NUL bytes) must
 * be fixed here once.
 */

/**
 * POSIX single-quote escape: wraps the input in `'…'`, with each embedded
 * single quote replaced by `'\''`. Safe to splice into a `/bin/sh`-compatible
 * command line where no parameter expansion is desired.
 */
export const quoteShellPath = (target: string): string => `'${target.replaceAll("'", `'\\''`)}'`;

const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/u;

export const quoteShellArgument = (value: string): string =>
  value.length > 0 && SHELL_SAFE_ARGUMENT.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
