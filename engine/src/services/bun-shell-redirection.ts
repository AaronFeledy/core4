/**
 * Reads one redirection operator the way Bun Shell's lexer does, and says whether Bun Shell
 * accepts it. `bun-shell-dialect.ts` owns the rest of the scan.
 */

export const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

export type Redirection =
  | { readonly kind: "ok"; readonly end: number }
  | {
      readonly kind: "issue";
      readonly end: number;
      readonly message: string;
      readonly suggestion: string;
      readonly replacement?: string;
    };

const FILE_TARGET = "Write &>file to send stdout and stderr to a file.";
const INPUT_TARGET = "Redirect input from a file with <file or a pipe.";

/**
 * Reads a redirection operator at `index`, or returns undefined when there is none. Like Bun
 * Shell, digits directly before `<` or `>` name the descriptor even at the end of a word.
 */
export const readRedirection = (source: string, index: number): Redirection | undefined => {
  let cursor = index;
  let descriptor = "";
  while (isDigit(source[cursor])) descriptor += source[cursor++];
  const operator = source[cursor];
  if (operator === "&" && descriptor === "") {
    if (source[cursor + 1] !== ">") return undefined;
    if (source[cursor + 2] === "&") {
      let end = cursor + 3;
      while (isDigit(source[end])) end += 1;
      return {
        kind: "issue",
        end,
        message: `Bun Shell does not support ${source.slice(index, end)}.`,
        suggestion: FILE_TARGET,
      };
    }
    return { kind: "ok", end: cursor + (source[cursor + 2] === ">" ? 3 : 2) };
  }
  if (operator !== "<" && operator !== ">") return undefined;
  if (operator === "<" && source[cursor + 1] === "<")
    return {
      kind: "issue",
      end: cursor + (source[cursor + 2] === "<" ? 3 : 2),
      message: "Bun Shell has no here-documents or here-strings.",
      suggestion: "Pipe the text in with printf or echo, or read it from a file.",
    };
  let end = cursor + 1;
  if (operator === ">" && source[end] === ">") end += 1;
  if (source[end] !== "&") return { kind: "ok", end };
  const target = source[end + 1];
  if (target === "-") {
    const text = source.slice(index, end + 2);
    return {
      kind: "issue",
      end: end + 2,
      message: `Bun Shell cannot close a descriptor with ${text}.`,
      suggestion: "Discard the output with 2>/dev/null instead.",
    };
  }
  if (isDigit(target)) {
    let targetEnd = end + 1;
    while (isDigit(source[targetEnd])) targetEnd += 1;
    const text = source.slice(index, targetEnd);
    const duplicate = source.slice(end + 1, targetEnd);
    if (operator === "<")
      return {
        kind: "issue",
        end: targetEnd,
        message: `Bun Shell does not support input duplication such as ${text}.`,
        suggestion: INPUT_TARGET,
      };
    // `>&N` means `1>&N`, so `>&2` is `1>&2` and `>&1` points stdout at itself.
    if (descriptor === "" && text === ">&2")
      return {
        kind: "issue",
        end: targetEnd,
        message: "Bun Shell needs an explicit source descriptor in >&2.",
        suggestion: "Write 1>&2.",
        replacement: "1>&2",
      };
    if (descriptor === "")
      return {
        kind: "issue",
        end: targetEnd,
        message: `Bun Shell needs an explicit source descriptor in ${text}.`,
        suggestion: duplicate === "1" ? "Remove it; it points stdout at itself." : "Write 1>&2 or 2>&1.",
      };
    if ((descriptor === "1" && duplicate === "2") || (descriptor === "2" && duplicate === "1"))
      return { kind: "ok", end: targetEnd };
    return {
      kind: "issue",
      end: targetEnd,
      message: `Bun Shell can only duplicate stdout and stderr onto each other, not ${text}.`,
      suggestion: "Write 1>&2 or 2>&1, or redirect to a file.",
    };
  }
  const text = source.slice(index, end + 1);
  return {
    kind: "issue",
    end: end + 1,
    message: `Bun Shell does not support ${text} with a file name.`,
    suggestion: operator === "<" ? INPUT_TARGET : FILE_TARGET,
  };
};
