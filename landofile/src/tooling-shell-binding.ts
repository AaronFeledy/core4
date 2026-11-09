import { ToolingCompileError } from "@lando/sdk/errors";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { type InvocationSite, evaluateInvocationSite } from "./invocation-sites.ts";
import { readsDynamicToolingVar } from "./tooling-dynamic-references.ts";

interface Frame {
  readonly kind: "top" | "command" | "backtick" | "parameter" | "arithmetic";
  quote: "single" | "double" | undefined;
  depth: number;
}

/** Scan assembled text, including static macro expansions, without interpreting bound data. */
const shellContext = (text: string) => {
  const frames: Frame[] = [{ kind: "top", quote: undefined, depth: 0 }];
  const heredocs: { readonly delimiter: string; readonly tabs: boolean }[] = [];
  let inHeredoc = false;
  let comment = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const frame = frames.at(-1);
    if (frame === undefined) break;
    if (inHeredoc) {
      const end = text.indexOf("\n", i);
      if (end === -1) return { refused: true, quote: frame.quote, escaped: false };
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
      ((char === "$" && text[i + 1] === "'") ||
        (frame.kind === "command" &&
          /[\s;|&()]/u.test(text[i - 1] ?? " ") &&
          /^case(?:\s|$)/u.test(text.slice(i))))
    ) {
      return { refused: true, quote: frame.quote, escaped: false };
    }
    if (char === '"') {
      frame.quote = frame.quote === "double" ? undefined : "double";
      continue;
    }
    if (char === "'" && frame.quote === undefined) {
      frame.quote = "single";
      continue;
    }
    if (char === "`") {
      frames.push({ kind: "backtick", quote: undefined, depth: 0 });
      continue;
    }
    if (char === "$" && text[i + 1] === "{") {
      frames.push({ kind: "parameter", quote: undefined, depth: 1 });
      i += 1;
      continue;
    }
    if (char === "$" && text[i + 1] === "(") {
      const arithmetic = text[i + 2] === "(";
      frames.push({
        kind: arithmetic ? "arithmetic" : "command",
        quote: undefined,
        depth: arithmetic ? 2 : 0,
      });
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
    quote: frames.at(-1)?.quote,
    escaped,
  };
};

export const bindToolingShellSite = (
  site: InvocationSite,
  context: ExpressionContext,
  names: ReadonlySet<string>,
): unknown => {
  if (!readsDynamicToolingVar(site.template, names)) return evaluateInvocationSite(site, context);
  let text = "";
  let trimNextLiteral = false;
  for (const segment of site.template.segments) {
    const result = evaluateInvocationSite(
      { ...site, template: { whole: false, segments: [segment] } },
      context,
    );
    const value =
      segment.kind === "LiteralSegment" && trimNextLiteral
        ? String(result).replace(/^\s+/u, "")
        : String(result);
    if (segment.kind !== "CommentSegment") {
      if (segment.kind === "InterpolationSegment" && segment.trimLeft) text = text.replace(/\s+$/u, "");
      trimNextLiteral = segment.kind === "InterpolationSegment" && segment.trimRight;
    }
    if (segment.kind !== "InterpolationSegment" || !readsDynamicToolingVar(segment.expression, names)) {
      text += value;
      continue;
    }
    const position = shellContext(text);
    if (position.refused || position.escaped)
      throw new ToolingCompileError({
        tool: "<tooling-task>",
        message: `Cannot safely bind a dynamic var at ${site.source.path.join(".")} in this shell context.`,
        remediation:
          "Move the interpolation to an ordinary shell word, single quote, or double quote outside backticks, heredocs, arithmetic, and parameter expansions.",
      });
    switch (position.quote) {
      case "single":
        text += value.replaceAll("'", "'\\''");
        break;
      case "double":
        text += value.replace(/[\\"$`]/gu, "\\$&");
        break;
      case undefined:
        text += `'${value.replaceAll("'", "'\\''")}'`;
        break;
      default:
        position.quote satisfies never;
    }
  }
  return text;
};
