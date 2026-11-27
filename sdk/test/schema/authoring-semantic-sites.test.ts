import { expect, test } from "bun:test";
import { override } from "@lando/sdk/landofile";
import {
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentNative,
  LandofileAuthoringShape,
  LandofileShape,
  deriveAuthoringAst,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { SchemaAST as AST, Result, Schema, SchemaTransformation } from "effect";
import { AUTHORING_READS } from "../../src/schema/authoring-semantics.ts";

const options = { errors: "all", onExcessProperty: "error" } as const;
const diagnostics = (schema: Schema.ConstraintDecoder<unknown, never>, value: unknown) => {
  const result = Schema.decodeUnknownResult(schema)(value, options);
  if (Result.isSuccess(result)) throw new TypeError("Expected invalid input");
  return validationIssuesFromSchemaIssue(result.failure.issue);
};

test.each([
  ["shape", LandofileAuthoringShape],
  ["fragment", LandofileAuthoringFragment],
  ["native fragment", LandofileAuthoringFragmentNative],
] as const)("enforces self-port admission in the %s decoder", (_name, schema) => {
  const rejected = { services: { cache: { port: "{{ service.port }}" } } };
  expect(diagnostics(schema, rejected).map(({ path }) => path)).toEqual([["services", "cache", "port"]]);
  for (const valid of [
    { services: { cache: { command: ["redis-server", "--port", "{{ service.port }}"] } } },
    { services: { cache: { environment: { PORT: "{{ service.port }}" } } } },
  ]) {
    expect(Schema.decodeUnknownResult(schema)(valid, options)._tag).toBe("Success");
  }
});

test("admits self-port inside a native override environment payload", () => {
  const input = { services: { cache: { environment: override({ PORT: "{{ service.port }}" }) } } };
  expect(Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(input, options)._tag).toBe("Success");
});

test.each([
  ["missing assignment", ["FOO"]],
  ["unsafe key", ["__proto__=x"]],
  ["null value", { FOO: null }],
] as const)("replays runtime env diagnostics for %s (#2194)", (_name, env) => {
  for (const value of [
    { tooling: { task: { service: "web", cmd: "echo ok", env } } },
    { services: { web: { environment: env } } },
  ]) {
    const expected = diagnostics(LandofileShape, value);
    for (const schema of [
      LandofileAuthoringShape,
      LandofileAuthoringFragment,
      LandofileAuthoringFragmentNative,
    ]) {
      expect(diagnostics(schema, value)).toEqual(expected);
    }
  }
});

test.each([false, true])(
  "%s declared reads determine whether an uncertain sibling defers a check",
  (declared) => {
    const source = Schema.Struct({ a: Schema.Number, b: Schema.Number, n: Schema.Number }).check(
      Schema.makeFilter(
        ({ a, b }) => a < b || { path: ["b"], issue: "Expected b greater than a" },
        declared ? { [AUTHORING_READS]: ["a", "b"] } : {},
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      deriveAuthoringAst(source.ast, {
        partial: true,
        slotFor: (kind) =>
          Schema.Struct({
            _tag: Schema.Literal("AuthoringExpression"),
            source: Schema.String,
            expectedType: Schema.Literal(kind),
          }).ast,
      }),
    );
    const result = Schema.decodeUnknownResult(derived)({
      a: 2,
      b: 1,
      n: { _tag: "AuthoringExpression", source: "{{ env.N }}", expectedType: "number" },
    });
    expect(result._tag).toBe(declared ? "Failure" : "Success");
    if (Result.isFailure(result)) {
      expect(validationIssuesFromSchemaIssue(result.failure.issue)).toEqual([
        expect.objectContaining({ path: ["b"], message: "Expected b greater than a" }),
      ]);
    }
  },
);

test("replays target-parser failures under a nested union without changing their kind", () => {
  const transformed = Schema.make<Schema.Codec<unknown>>(
    new AST.Number(undefined, undefined, [
      new AST.Link(
        Schema.String.ast,
        SchemaTransformation.transform({
          decode: (value: unknown) => value,
          encode: (value: unknown) => value,
        }),
      ),
    ]),
  );
  const source = Schema.Struct({ value: Schema.Union([transformed, Schema.Literal(false)]) });
  const derived = Schema.make<Schema.Codec<unknown>>(
    deriveAuthoringAst(source.ast, {
      partial: true,
      slotFor: () => Schema.Never.ast,
    }),
  );
  expect(diagnostics(derived, { value: "bad" })).toEqual(diagnostics(source, { value: "bad" }));
});
