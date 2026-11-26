import { Predicate, Schema } from "effect";
import { servicePortExpression } from "../landofile/execution-sites.ts";
import { isLandofileOverride } from "../landofile/merge-directives.ts";
import { AuthoringExpression } from "./landofile-authoring-expression.ts";
import type { ValidationIssuePath } from "./validation-issue.ts";

const isExpression = Schema.is(AuthoringExpression);

export const authoringSelfScope = Schema.makeFilter((value: unknown) => {
  const issues: { readonly path: ValidationIssuePath; readonly issue: string }[] = [];
  const visit = (entry: unknown, path: ValidationIssuePath): void => {
    if (isLandofileOverride(entry)) {
      visit(entry.value, path);
      return;
    }
    if (!Predicate.isObjectOrArray(entry)) return;
    if ("_tag" in entry && entry._tag === "AuthoringExpression" && isExpression(entry)) {
      if (!entry.scopes.includes("service")) return;
      const admission = servicePortExpression(entry.template, path);
      if (admission === "unsupported-member")
        issues.push({ path, issue: "Only the direct expression member service.port is supported." });
      if (admission === "unsupported-site")
        issues.push({
          path,
          issue:
            "service.port is available only in a service command, entrypoint, map-form environment, or container probe command.",
        });
      return;
    }
    for (const [key, child] of Object.entries(entry))
      visit(child, [...path, Array.isArray(entry) ? Number(key) : key]);
  };
  visit(value, []);
  return issues.length === 0 ? undefined : issues;
});
