// Lando 3's API-4 `type: lando` service splits single-line commands with string-argv 0.1.1.
const STRING_ARGV = /([^\s'"]+(['"])([\s\S]*?)\2)|[^\s'"]+|(['"])([\s\S]*?)\4/gu;

/**
 * A word that starts unquoted keeps its quotes; a leading quote groups and is stripped unless
 * empty. Backslashes are literal, unmatched quotes are skipped, and nothing is rejected.
 */
export const splitStringArgv = (input: string): readonly string[] =>
  Array.from(input.matchAll(STRING_ARGV), (match) => match[1] || match[5] || match[0]);
