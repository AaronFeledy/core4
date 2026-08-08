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
