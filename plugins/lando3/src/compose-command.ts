/**
 * Compose uses go-shellwords v1.0.12 with ParseEnv/ParseBacktick disabled.
 * This is word splitting, not shell evaluation: even substitutions stay literal.
 * Undefined means malformed input; an empty array is a valid empty command.
 */
export const splitComposeCommand = (input: string): readonly string[] | undefined => {
  const args: string[] = [];
  let word = "";
  let started = false;
  let escaped = false;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backQuoted = false;
  let dollarQuoted = false;

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
      if (char === ">" && /^[0-9]/u.test(word)) started = false;
      break;
    }
    word += char;
    started = true;
  }
  if (escaped || singleQuoted || doubleQuoted || backQuoted || dollarQuoted) return undefined;
  if (started) args.push(word);
  return args;
};
