import { SchemaAST as AST, Predicate, Result, Schema, SchemaIssue } from "effect";
import { recordSemanticSite } from "./authoring-issue-metadata.ts";
import {
  authoringReads,
  authoringSubsetSafe,
  containsAuthoringExpression,
  projectAuthoringValue,
} from "./authoring-semantics.ts";

// ==== Runtime replay is permitted only after certainty has been established.
const decoder = (ast: AST.AST) => Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown>>(ast));

const precisionCheck = (source: AST.Objects, complete: (ast: AST.AST) => AST.AST) => {
  const picks = new WeakMap<
    AST.Filter<unknown>,
    {
      readonly ast: AST.Objects;
      readonly completeness: ReturnType<typeof decoder>;
      readonly decode: ReturnType<typeof decoder>;
    }
  >();
  const subset = decoder(new AST.Objects([], source.indexSignatures));
  return (check: AST.Filter<unknown>, value: object, options: AST.ParseOptions) => {
    const reads = authoringReads(check);
    let input: unknown;
    let decode: ReturnType<typeof decoder>;
    if (reads !== undefined) {
      let pick = picks.get(check);
      if (pick === undefined) {
        const ast = new AST.Objects(
          source.propertySignatures.filter((property) => reads.includes(String(property.name))),
          [],
        );
        pick = { ast, completeness: decoder(complete(ast)), decode: decoder(ast) };
        picks.set(check, pick);
      }
      input = Object.fromEntries(
        pick.ast.propertySignatures
          .filter((property) => Object.hasOwn(value, property.name))
          .map((property) => [property.name, Reflect.get(value, property.name)]),
      );
      if (containsAuthoringExpression(input)) return undefined;
      if (Result.isFailure(pick.completeness(input, options))) return undefined;
      decode = pick.decode;
    } else if (authoringSubsetSafe(check) && source.indexSignatures.length > 0) {
      input = Object.fromEntries(
        Object.entries(value).filter(([key, entry]) => {
          if (containsAuthoringExpression(entry)) return false;
          return Result.isSuccess(subset({ [key]: entry }, options));
        }),
      );
      decode = subset;
    } else {
      return undefined;
    }
    const decoded = decode(input, options);
    if (Result.isFailure(decoded)) return undefined;
    const issue = check.run(decoded.success, source, options);
    return issue === undefined ? undefined : new SchemaIssue.Filter(check, issue, value, options);
  };
};

export const authoringSemanticSite = (
  source: AST.AST,
  complete: ((ast: AST.AST) => AST.AST) | undefined,
  annotations: Schema.Annotations.Annotations | undefined,
): AST.Filter<unknown> => {
  const replay = decoder(source);
  // Lazy because recursive authoring trees have not been memoized when a site is created.
  let completeness: ReturnType<typeof decoder> | undefined;
  const precise =
    source.encoding === undefined && AST.isObjects(source)
      ? precisionCheck(source, complete ?? ((ast) => ast))
      : undefined;
  const filter = new AST.Filter(
    (input, _self, options) => {
      const value = projectAuthoringValue(input);
      const expression = containsAuthoringExpression(value);
      if (!expression) {
        completeness ??= complete === undefined ? undefined : decoder(complete(source));
        if (completeness === undefined || Result.isSuccess(completeness(value, options))) {
          const result = replay(value, options);
          return Result.isFailure(result) ? result.failure.issue : undefined;
        }
      }
      if (precise === undefined || !Predicate.isObject(value)) return undefined;
      const issues: SchemaIssue.Issue[] = [];
      const visit = (check: AST.Check<unknown>): boolean => {
        const start = issues.length;
        switch (check._tag) {
          case "Filter": {
            const issue = precise(check, value, options);
            if (issue !== undefined) issues.push(issue);
            break;
          }
          case "FilterGroup":
            for (const child of check.checks) if (visit(child)) break;
            break;
          default:
            return check satisfies never;
        }
        const last = issues.at(-1);
        return (
          issues.length > start &&
          (options.errors !== "all" || (last?._tag === "Filter" && last.filter.aborted))
        );
      };
      for (const check of source.checks ?? []) if (visit(check)) break;
      const [first, ...rest] = issues;
      if (first === undefined || rest.length === 0) return first;
      return new SchemaIssue.Composite(source, [first, ...rest], value, options);
    },
    annotations,
    true,
  );
  recordSemanticSite(filter, source);
  return filter;
};
