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

/** Resolve the execution semantics of an authored string path. */
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

/** Only process text, excluding Compose's probe mode marker and other probe fields. */
const servicePortExpressionSite = (path: ReadonlyArray<string | number>): boolean => {
  if (path[0] !== "services") return false;
  const match = executionSiteAt(path);
  if (match?.site === "service-command" || match?.site === "service-entrypoint") return true;
  if (match?.site !== "healthcheck") return false;
  const [field, index] = match.relativePath;
  return (
    field === undefined ||
    typeof field === "number" ||
    field === "command" ||
    (field === "test" && index !== 0)
  );
};

export const servicePortExpression = (template: ExpressionTemplate, path: ReadonlyArray<string | number>) => {
  const self = expressionScopeMembers(template, "service", "direct-property");
  if (!self.analyzable) return "unsupported-member";
  if (self.members.size === 0) return "absent";
  if (self.members.size !== 1 || !self.members.has("port")) return "unsupported-member";
  return servicePortExpressionSite(path) ? "supported" : "unsupported-site";
};
