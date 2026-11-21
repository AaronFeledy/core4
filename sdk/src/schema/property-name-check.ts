import { Effect, Predicate, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect";
import { decodeUnknownEffect } from "effect/SchemaParser";
import { SchemaDeclarationInputAnnotationId } from "./map-input.ts";

const checkedRecordProjection = "lando/checked-record-projection";

export const propertyNameRecordProjection = (ast: SchemaAST.AST): SchemaAST.AST | undefined => {
  const projection = ast.annotations?.[checkedRecordProjection];
  return SchemaAST.isAST(projection) ? projection : undefined;
};

/** Check raw names independently: Effect's object filters normally run only after the values decode. */
export const propertyNameCheckedRecord = <A, I>(
  record: Schema.Codec<A, I>,
  ...checks: [SchemaAST.Filter<unknown>, ...SchemaAST.Filter<unknown>[]]
): Schema.Codec<A, I> => {
  const projection = record.check(...checks).ast;
  return Schema.make<Schema.Codec<A, I>>(
    new SchemaAST.Declaration(
      [record.ast],
      ([body = record.ast]) => {
        const decode = decodeUnknownEffect(Schema.make<Schema.Codec<A, I>>(body));
        return (input, _ast, options) => {
          const keyIssues = [];
          if (!options.disableChecks)
            for (const check of checks) {
              const issue = check.run(input, body, options);
              if (issue === undefined) continue;
              if (options.errors !== "all") return Effect.fail(issue);
              keyIssues.push(issue);
            }
          const [first, ...rest] = keyIssues;
          if (first === undefined) return decode(input, options);
          return Effect.matchEffect(decode(input, options), {
            onFailure: (bodyIssue) => {
              const children = bodyIssue._tag === "Composite" ? bodyIssue.issues : [bodyIssue];
              const independent = children.filter((issue) => {
                if (
                  issue._tag !== "Pointer" ||
                  issue.issue._tag !== "UnexpectedKey" ||
                  issue.path.length !== 1
                )
                  return true;
                const [key] = issue.path;
                return (
                  key === undefined ||
                  !checks.some((check) => check.run({ [key]: undefined }, body, options) !== undefined)
                );
              });
              return Effect.fail(new SchemaIssue.Composite(body, [first, ...rest, ...independent]));
            },
            onSuccess: () => Effect.fail(new SchemaIssue.Composite(body, [first, ...rest])),
          });
        };
      },
      {
        "lando/map-input": true,
        [SchemaDeclarationInputAnnotationId]: record.ast,
        [checkedRecordProjection]: projection,
        toCodecJson: () => new SchemaAST.Link(projection, SchemaTransformation.passthrough()),
      },
      undefined,
      undefined,
      record.ast.context,
    ),
  );
};

export const indexedPropertyNameCheck = (pattern: RegExp, message: string, reason?: string) =>
  Schema.makeFilter(
    (input: unknown, _ast, options) => {
      if (!Predicate.isObject(input)) return undefined;
      let issues: Array<Schema.FilterIssue> | undefined;
      for (const key of Object.keys(input)) {
        if (pattern.test(key)) continue;
        // This declaration calls check.run directly, so there is no Filter wrapper.
        const issue = {
          path: [key],
          issue: new SchemaIssue.InvalidValue({ message, "lando/issue-reason": reason }, key, options),
        };
        if (options.errors !== "all") return issue;
        issues ??= [];
        issues.push(issue);
      }
      return issues;
    },
    {
      "lando/indexed-property-names": true,
      "~structural": true,
      toJsonSchema: () => ({ propertyNames: { pattern: pattern.source } }),
    },
  );
