export interface SplitCommand {
  readonly argv: readonly string[];
  /** An unquoted shell operator ended parsing; Compose silently ignores the rest. */
  readonly truncated: boolean;
}

/**
 * Compose uses go-shellwords v1.0.12 with ParseEnv/ParseBacktick disabled.
 * This is word splitting, not shell evaluation: even substitutions stay literal.
 * Undefined means malformed input; an empty argv is a valid empty command.
 */
export const splitComposeCommand = (input: string): SplitCommand | undefined => {
  const args: string[] = [];
  let word = "";
  let started = false;
  let escaped = false;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backQuoted = false;
  let dollarQuoted = false;
  let truncated = false;

  for (const char of input) {
    if (escaped) {
      word += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === "\\" && !singleQuoted) {
      escaped = true;
      continue;
    }
    const quoted = singleQuoted || doubleQuoted || backQuoted || dollarQuoted;
    if (" \t\r\n".includes(char) && !quoted) {
      if (started) args.push(word);
      word = "";
      started = false;
      continue;
    }
    if (char === '"' && !singleQuoted && !dollarQuoted) {
      doubleQuoted = !doubleQuoted;
      if (!doubleQuoted) started = true;
      continue;
    }
    if (char === "'" && !doubleQuoted && !dollarQuoted) {
      singleQuoted = !singleQuoted;
      if (!singleQuoted) started = true;
      continue;
    }
    if (char === "`" && !singleQuoted && !doubleQuoted && !dollarQuoted) {
      backQuoted = !backQuoted;
    }
    if (char === "(" && !singleQuoted && !doubleQuoted && !backQuoted) {
      if (dollarQuoted || !word.endsWith("$")) return undefined;
      dollarQuoted = true;
    }
    if (char === ")" && !singleQuoted && !doubleQuoted && !backQuoted) {
      dollarQuoted = !dollarQuoted;
    }
    // Compose discards shellwords' remaining-input position at an unquoted operator.
    if (";&|<>".includes(char) && !quoted) {
      // go-shellwords drops a word whose first byte is a digit before `>` (a file descriptor).
      if (char === ">" && /^[0-9]/u.test(word)) started = false;
      truncated = true;
      break;
    }
    word += char;
    started = true;
  }
  if (escaped || singleQuoted || doubleQuoted || backQuoted || dollarQuoted) return undefined;
  if (started) args.push(word);
  return { argv: args, truncated };
};
