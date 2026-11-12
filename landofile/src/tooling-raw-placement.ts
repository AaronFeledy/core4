import { expressionScopeMembers } from "@lando/sdk/expressions";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { nextShellSegment, shellContext } from "./tooling-shell-context.ts";

export const rawPlacementRefused = (site: ParsedPendingSite): boolean => {
  const shell =
    (site.path[0] === "cmd" && site.path.length === 1) ||
    (site.path[0] === "cmds" && (site.path.length === 2 || site.path[2] === "cmd")) ||
    (site.path[0] === "vars" && site.path[2] === "sh");
  if (!shell) {
    if (site.path[0] !== "cmd" || typeof site.path[1] !== "number") return true;
    const segment = site.template.segments[0];
    return !(
      site.template.whole &&
      segment?.kind === "InterpolationSegment" &&
      segment.expression.kind === "Path" &&
      segment.expression.head === "raw" &&
      segment.expression.segments.length === 0
    );
  }
  let text = "";
  let unresolvedPrefix = false;
  for (const [index, segment] of site.template.segments.entries()) {
    switch (segment.kind) {
      case "LiteralSegment":
        text += segment.text;
        break;
      case "CommentSegment":
        break;
      case "InterpolationSegment": {
        if (segment.trimLeft) text = text.replace(/\s+$/u, "");
        const raw = expressionScopeMembers(segment.expression, "raw");
        if (!raw.analyzable || raw.members.size > 0) {
          if (unresolvedPrefix) return false;
          const position = shellContext(text);
          const next = nextShellSegment(site.template.segments, index, segment.trimRight);
          if (
            position.refused ||
            position.escaped ||
            position.quote !== undefined ||
            position.word !== "" ||
            !position.command ||
            position.redirect ||
            !(next === undefined || (next.kind === "LiteralSegment" && /^[\s;|&<>()]/u.test(next.text)))
          )
            return true;
        } else unresolvedPrefix = true;
        text += "'value'";
        break;
      }
      case "ShellParamSegment":
        text += `$${segment.name}`;
        break;
      case "SecretRefSegment":
        text += "'value'";
        break;
      default:
        segment satisfies never;
    }
  }
  return false;
};
