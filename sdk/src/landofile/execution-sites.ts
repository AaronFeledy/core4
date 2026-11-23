import { SchemaAST as AST, Schema } from "effect";
import type { ExpressionTemplate } from "../expressions/ast.ts";
import { expressionScopeMembers } from "../expressions/scopes.ts";
import { ExecutionSite, getExecutionSite } from "../schema/execution-site.ts";
import { LandofileShape } from "../schema/landofile.ts";
import { ValidationIssuePath } from "../schema/validation-issue.ts";
import { childAsts } from "./directive-paths.ts";

export const ExecutionSiteMatch = Schema.Struct({
  site: ExecutionSite.annotate({
    description: "Execution semantics of the matched string.",
  }),
  relativePath: ValidationIssuePath.annotate({
    description: "Path within the matched execution site, empty for the site itself.",
  }),
}).annotate({
  identifier: "ExecutionSiteMatch",
  title: "Execution Site Match",
  description: "Execution semantics and relative path resolved for an authored Landofile string.",
});
export type ExecutionSiteMatch = typeof ExecutionSiteMatch.Type;

interface Candidate {
  readonly ast: AST.AST;
  readonly match: { readonly site: ExecutionSite; readonly index: number } | undefined;
}

const branches = (candidate: Candidate, index: number): ReadonlyArray<Candidate> => {
  const ast = AST.toEncoded(candidate.ast);
  const site = getExecutionSite(ast) ?? getExecutionSite(candidate.ast);
  const match = site === undefined ? candidate.match : { site, index };
  const next = (node: AST.AST) => branches({ ast: node, match }, index);
  switch (ast._tag) {
    case "Union":
      return ast.types.flatMap(next);
    case "Suspend":
      return next(ast.thunk());
    case "Declaration":
      return ast.typeParameters.flatMap(next);
    default:
      return [{ ast, match }];
  }
};

export const executionSiteAt = (path: ReadonlyArray<string | number>): ExecutionSiteMatch | undefined => {
  let candidates = branches({ ast: LandofileShape.ast, match: undefined }, -1);
  for (const [index, key] of path.entries()) {
    candidates = candidates.flatMap((candidate) =>
      childAsts(candidate.ast, key).flatMap((ast) => branches({ ast, match: candidate.match }, index)),
    );
  }
  const strings = candidates.filter(
    ({ ast }) => ast._tag === "String" || (ast._tag === "Literal" && typeof ast.literal === "string"),
  );
  const match = strings[0]?.match;
  if (
    match === undefined ||
    strings.some((candidate) => candidate.match?.site !== match.site || candidate.match.index !== match.index)
  )
    return undefined;
  return { site: match.site, relativePath: path.slice(match.index + 1) };
};

export const isServiceEnvironmentValuePath = (path: readonly (string | number)[]): boolean =>
  path.length === 4 &&
  path[0] === "services" &&
  typeof path[1] === "string" &&
  path[2] === "environment" &&
  typeof path[3] === "string";

export const servicePortExpression = (template: ExpressionTemplate, path: ReadonlyArray<string | number>) => {
  if (isServiceEnvironmentValuePath(path)) {
    const self = expressionScopeMembers(template, "service");
    if ((self.members.has("url") && self.members.size === 1) || (!self.analyzable && self.members.size === 0))
      return "url";
  }
  const self = expressionScopeMembers(template, "service", "direct-property");
  if (!self.analyzable) return "unsupported-member";
  if (self.members.size === 0) return "absent";
  if (self.members.size !== 1 || !self.members.has("port")) return "unsupported-member";
  if (path[0] !== "services") return "unsupported-site";
  if (isServiceEnvironmentValuePath(path)) return "supported";
  const match = executionSiteAt(path);
  if (
    match?.site === "service-command" ||
    match?.site === "service-entrypoint" ||
    match?.site === "service-extra-args"
  )
    return "supported";
  if (match?.site !== "healthcheck") return "unsupported-site";
  const [field, index] = match.relativePath;
  // Compose reserves the first test element for its probe mode marker.
  if (field === "test") return index === 0 ? "unsupported-site" : "supported";
  return field === undefined || typeof field === "number" || field === "command"
    ? "supported"
    : "unsupported-site";
};
