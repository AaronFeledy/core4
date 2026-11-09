import { ToolingCompileError } from "@lando/sdk/errors";
import { type ExpressionContext, expressionScopeMembers } from "@lando/sdk/expressions";
import { type InvocationSite, evaluateInvocationSite } from "./invocation-sites.ts";
import { readsToolingData } from "./tooling-provenance.ts";
import { nextShellSegment, shellContext } from "./tooling-shell-context.ts";

const quoteWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const shellBindingError = (site: InvocationSite) =>
  new ToolingCompileError({
    tool: "<tooling-task>",
    message: `Cannot safely bind invocation data at ${site.source.path.join(".")} in this shell context.`,
    remediation: `Move the interpolation at ${site.source.path.join(".")} to an ordinary argument outside backticks, heredocs, arithmetic, parameter expansions, and dollar-prefixed quotes. Place raw alone in an unquoted argument, never as the executable or a redirection operand.`,
  });

export const bindToolingShellSite = (
  site: InvocationSite,
  context: ExpressionContext,
  names: ReadonlySet<string>,
): string => {
  let text = "";
  let trimNextLiteral = false;
  for (const [index, segment] of site.template.segments.entries()) {
    if (segment.kind === "InterpolationSegment" && segment.trimLeft) text = text.replace(/\s+$/u, "");
    const result = evaluateInvocationSite(
      { ...site, template: { whole: true, segments: [segment] } },
      context,
    );
    const value =
      segment.kind === "LiteralSegment" && trimNextLiteral
        ? String(result).replace(/^\s+/u, "")
        : String(result);
    if (segment.kind !== "CommentSegment")
      trimNextLiteral = segment.kind === "InterpolationSegment" && segment.trimRight;
    if (segment.kind !== "InterpolationSegment" || !readsToolingData(segment.expression, names)) {
      text += value;
      continue;
    }
    const position = shellContext(text);
    if (position.refused || position.escaped || position.dollar) throw shellBindingError(site);
    const next = nextShellSegment(site.template.segments, index, segment.trimRight);
    const endsWord =
      next === undefined || (next.kind === "LiteralSegment" && /^[\s;|&<>()]/u.test(next.text));
    const ordinaryWord =
      position.quote === undefined &&
      position.word === "" &&
      position.command &&
      !position.redirect &&
      endsWord;
    const raw = expressionScopeMembers(segment.expression, "raw");
    if ((!raw.analyzable || raw.members.size > 0) && !ordinaryWord) throw shellBindingError(site);
    if (Array.isArray(result)) {
      if (!ordinaryWord || result.some((entry) => typeof entry !== "string")) throw shellBindingError(site);
      text += result.map(quoteWord).join(" ");
      continue;
    }
    switch (position.quote) {
      case "single":
        text += value.replaceAll("'", "'\\''");
        break;
      case "double":
        text += value.replace(/[\\"$`]/gu, "\\$&");
        break;
      case undefined:
        text += value === "" && ordinaryWord ? "" : quoteWord(value);
        break;
      default:
        position.quote satisfies never;
    }
  }
  return text;
};
