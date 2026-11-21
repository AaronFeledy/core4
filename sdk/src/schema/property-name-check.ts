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
  check: SchemaAST.Filter<unknown>,
): Schema.Codec<A, I> => {
  const projection = record.check(check).ast;
  return Schema.make<Schema.Codec<A, I>>(
    new SchemaAST.Declaration(
      [record.ast],
      ([body = record.ast]) => {
        const decode = decodeUnknownEffect(Schema.make<Schema.Codec<A, I>>(body));
        return (input, _ast, options) => {
          const keyIssue = options.disableChecks ? undefined : check.run(input, body, options);
          if (keyIssue === undefined) return decode(input, options);
          if (options.errors !== "all") return Effect.fail(keyIssue);
          return Effect.matchEffect(decode(input, options), {
            onFailure: (bodyIssue) => Effect.fail(new SchemaIssue.Composite(body, [keyIssue, bodyIssue])),
            onSuccess: () => Effect.fail(keyIssue),
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

export const indexedPropertyNameCheck = (pattern: RegExp, message: string) =>
  Schema.makeFilter(
    (input: unknown, _ast, options) => {
      if (!Predicate.isObject(input)) return undefined;
      let issues: Array<Schema.FilterIssue> | undefined;
      for (const key of Object.keys(input)) {
        if (pattern.test(key)) continue;
        const issue = { path: [key], issue: message };
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
