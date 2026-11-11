import type { ExpressionSegment } from "@lando/sdk/expressions";
import type { ShellInsertion } from "./tooling-shell-insertion.ts";

export const nextShellSegment = (
  segments: readonly ExpressionSegment[],
  index: number,
  trimRight: boolean,
): ExpressionSegment | undefined => {
  let trim = trimRight;
  for (const segment of segments.slice(index + 1)) {
    if (segment.kind === "CommentSegment") continue;
    if (segment.kind !== "LiteralSegment") return segment;
    const text = trim ? segment.text.replace(/^\s+/u, "") : segment.text;
    trim = false;
    if (text !== "") return { ...segment, text };
  }
  return undefined;
};

interface Frame {
  readonly kind: "top" | "command" | "backtick" | "parameter" | "arithmetic";
  quote: "single" | "double" | undefined;
  depth: number;
  word: string;
  command: boolean;
  redirect: boolean;
}

/** Scan assembled text, including static macro expansions, without interpreting bound data. */
export const shellContext = (text: string) => {
  const frameFor = (kind: Frame["kind"], depth = 0): Frame => ({
    kind,
    quote: undefined,
    depth,
    word: "",
    command: false,
    redirect: false,
  });
  const frames: Frame[] = [frameFor("top")];
  const finishWord = (frame: Frame) => {
    if (frame.word === "") return;
    if (frame.redirect) frame.redirect = false;
    else if (!/^[A-Za-z_][A-Za-z0-9_]*=/u.test(frame.word)) frame.command = true;
    frame.word = "";
  };
  const heredocs: { readonly delimiter: string; readonly tabs: boolean }[] = [];
  let inHeredoc = false;
  let comment = false;
  let escaped = false;
  let dollar = false;
  let caseRefusal = false;
  let dollarQuoteRefusal = false;
  const insertion = (): ShellInsertion => {
    if (heredocs.length > 0) return "heredoc";
    if (comment) return "comment";
    const kinds = frames.map((frame) => frame.kind);
    if (kinds.includes("backtick")) return "backtick";
    if (kinds.includes("arithmetic")) return "arithmetic";
    if (kinds.includes("parameter")) return "parameter";
    if (caseRefusal) return "case";
    if (dollarQuoteRefusal) return "dollar-quote";
    if (escaped) return "escaped";
    switch (frames.at(-1)?.quote) {
      case "single":
        return "single";
      case "double":
        return "double";
      default:
        return "unquoted";
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const frame = frames.at(-1);
    if (frame === undefined) break;
    if (i === text.length - 1) dollar = char === "$" && !escaped && frame.quote !== "single";
    if (inHeredoc) {
      const end = text.indexOf("\n", i);
      if (end === -1)
        return { refused: true, quote: frame.quote, escaped: false, insertion: "heredoc" as const };
      const here = heredocs[0];
      const line = text.slice(i, end);
      if (here !== undefined && (here.tabs ? line.replace(/^\t+/u, "") : line) === here.delimiter) {
        heredocs.shift();
        inHeredoc = heredocs.length > 0;
      }
      i = end;
      continue;
    }
    if (comment) {
      if (char === "\n") comment = false;
      else continue;
    }
    if (escaped) {
      escaped = false;
      frame.word += "x";
      continue;
    }
    if (frame.quote === "single") {
      if (char === "'") frame.quote = undefined;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (frame.kind === "backtick" && char === "`") {
      frames.pop();
      continue;
    }
    if (
      frame.quote === undefined &&
      ((char === "$" && (text[i + 1] === "'" || text[i + 1] === '"')) ||
        (frame.kind === "command" &&
          /[\s;|&()]/u.test(text[i - 1] ?? " ") &&
          /^case(?:\s|$)/u.test(text.slice(i))))
    ) {
      const dollarQuote = char === "$";
      caseRefusal = !dollarQuote;
      dollarQuoteRefusal = dollarQuote;
      return {
        refused: true,
        quote: frame.quote,
        escaped: false,
        insertion: dollarQuote ? ("dollar-quote" as const) : ("case" as const),
      };
    }
    if (char === '"') {
      frame.word += "x";
      frame.quote = frame.quote === "double" ? undefined : "double";
      continue;
    }
    if (char === "'" && frame.quote === undefined) {
      frame.word += "x";
      frame.quote = "single";
      continue;
    }
    if (char === "`") {
      frame.word += "x";
      frames.push(frameFor("backtick"));
      continue;
    }
    if (char === "$" && text[i + 1] === "{") {
      frame.word += "x";
      frames.push(frameFor("parameter", 1));
      i += 1;
      continue;
    }
    if (char === "$" && text[i + 1] === "(") {
      const arithmetic = text[i + 2] === "(";
      frame.word += "x";
      frames.push(frameFor(arithmetic ? "arithmetic" : "command", arithmetic ? 2 : 0));
      i += arithmetic ? 2 : 1;
      continue;
    }
    if (frame.quote !== undefined) continue;
    if (frame.kind === "parameter" || frame.kind === "arithmetic") {
      const open = frame.kind === "parameter" ? "{" : "(";
      const close = frame.kind === "parameter" ? "}" : ")";
      if (char === open) frame.depth += 1;
      if (char === close) {
        frame.depth -= 1;
        if (frame.depth === 0) frames.pop();
      }
      continue;
    }
    if (char === "#" && (i === 0 || /[\s;|&()]/u.test(text[i - 1] ?? ""))) {
      comment = true;
      continue;
    }
    if (char === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const tabs = text[i + 2] === "-";
      let end = i + (tabs ? 3 : 2);
      while (text[end] === " " || text[end] === "\t") end += 1;
      let delimiter = "";
      let quote: "'" | '"' | undefined;
      for (; end < text.length; end += 1) {
        const part = text[end];
        if (part === quote) {
          quote = undefined;
          continue;
        }
        if (quote === "'") {
          delimiter += part;
          continue;
        }
        if ((part === "'" || part === '"') && quote === undefined) {
          quote = part;
          continue;
        }
        if (part === "\\" && (quote === undefined || /[\\"$`\n]/u.test(text[end + 1] ?? ""))) {
          end += 1;
          delimiter += text[end] === "\n" ? "" : (text[end] ?? "");
          continue;
        }
        if (quote === undefined && /[\s;|&<>]/u.test(part ?? "")) break;
        delimiter += part;
      }
      heredocs.push({ delimiter, tabs });
      i = end - 1;
      continue;
    }
    if (char === "\n" && heredocs.length > 0) inHeredoc = true;
    if (/\s/u.test(char ?? "")) {
      finishWord(frame);
      if (char === "\n") frame.command = false;
    } else if (/[;|&()]/u.test(char ?? "")) {
      finishWord(frame);
      frame.command = false;
    } else if (char === ">" || char === "<") {
      if (!/^\d*$/u.test(frame.word)) finishWord(frame);
      frame.word = "";
      frame.redirect = true;
    } else frame.word += char;
    if (frame.kind === "command") {
      if (char === "(") frame.depth += 1;
      if (char === ")") {
        if (frame.depth === 0) frames.pop();
        else frame.depth -= 1;
      }
    }
  }
  return {
    refused:
      heredocs.length > 0 ||
      comment ||
      frames.some((frame) => ["backtick", "parameter", "arithmetic"].includes(frame.kind)),
    insertion: insertion(),
    quote: frames.at(-1)?.quote,
    escaped,
    dollar,
    word: frames.at(-1)?.word ?? "",
    command: frames.at(-1)?.command ?? false,
    redirect: frames.at(-1)?.redirect ?? false,
  };
};
