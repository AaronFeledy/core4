import { SchemaAST as AST, Schema } from "effect";
import { ExecutionSite, getExecutionSite } from "../schema/execution-site.ts";
import { LandofileShape } from "../schema/landofile.ts";
import { ValidationIssuePath } from "../schema/validation-issue.ts";
import { childAsts } from "./directive-paths.ts";

export const ExecutionSiteMatch = Schema.Struct({
  site: ExecutionSite,
  relativePath: ValidationIssuePath,
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

/** Resolve authored string sites only on diagnostic paths, never during successful loading. */
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
