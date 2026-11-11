import { expect, test } from "bun:test";
import { override, reset } from "@lando/sdk/landofile";
import { deriveAuthoringAst, validationIssuesFromSchemaIssue } from "@lando/sdk/schema";
import { SchemaAST as AST, Result, Schema, SchemaTransformation } from "effect";
import { AUTHORING_READS } from "../../src/schema/authoring-semantics.ts";

const slotFor = (kind: string) =>
  Schema.Struct({
    _tag: Schema.Literal("AuthoringExpression"),
    source: Schema.String,
    expectedType: Schema.Literal(kind),
  }).ast;
const expression = (expectedType: string) => ({
  _tag: "AuthoringExpression",
  source: "{{ env.VALUE }}",
  expectedType,
});
const options = { errors: "all", onExcessProperty: "error" } as const;

const input = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("alpha"), n: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("beta"), s: Schema.String }),
]);
const runtime = Schema.Struct({
  value: input.pipe(
    Schema.decodeTo(
      Schema.toType(input).check(Schema.makeFilter(() => "Runtime target rejected")),
      SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
    ),
  ),
});
const derived = Schema.make<Schema.Codec<unknown>>(
  deriveAuthoringAst(runtime.ast, {
    partial: true,
    rootExpression: false,
    slotFor,
    directives: true,
    nativeDirectives: true,
  }),
);

test.each([
  ["whole expression", expression("object")],
  ["nested expression", { kind: "alpha", n: expression("number") }],
  ["missing member", { kind: "alpha" }],
  ["missing discriminator", { n: 1 }],
  ["expression discriminator", { kind: expression("string"), n: 1 }],
  ["reset member", { kind: "alpha", n: reset() }],
  ["override expression", override(expression("object"))],
] as const)("defers runtime replay for an uncertain %s", (_name, value) => {
  expect(Schema.decodeUnknownResult(derived)({ value }, options)._tag).toBe("Success");
});

test("replays certain override payloads and retains runtime diagnostics under a union", () => {
  const value = { kind: "alpha", n: 1 };
  const effective = Schema.decodeUnknownResult(runtime)({ value }, options);
  const fragment = Schema.decodeUnknownResult(derived)({ value: override(value) }, options);
  if (Result.isSuccess(effective) || Result.isSuccess(fragment))
    throw new TypeError("Expected both decoders to fail");
  expect(validationIssuesFromSchemaIssue(fragment.failure.issue)).toEqual(
    validationIssuesFromSchemaIssue(effective.failure.issue),
  );
});

test.each([false, true])("preserves FilterGroup order and aborted=%s for declared reads", (aborted) => {
  const seen: number[] = [];
  const first = Schema.makeFilter(
    () => {
      seen.push(1);
      return "first";
    },
    { [AUTHORING_READS]: ["n"] },
  );
  const second = Schema.makeFilter(
    () => {
      seen.push(2);
      return "second";
    },
    { [AUTHORING_READS]: ["n"] },
  );
  const source = Schema.Struct({ n: Schema.Number, unknown: Schema.String }).check(
    (aborted ? first.abort() : first).and(second),
  );
  const authoring = Schema.make<Schema.Codec<unknown>>(
    deriveAuthoringAst(source.ast, {
      partial: true,
      slotFor,
      rootExpression: false,
    }),
  );
  const result = Schema.decodeUnknownResult(authoring)({ n: 1, unknown: expression("string") }, options);
  if (Result.isSuccess(result)) throw new TypeError("Expected check failure");
  expect(seen).toEqual(aborted ? [1] : [1, 2]);
  expect(validationIssuesFromSchemaIssue(result.failure.issue).map((issue) => issue.message)).toEqual(
    aborted ? ["first"] : ["first", "second"],
  );
});

test("keeps directive and native-directive derivation variants distinct with a shared slot factory", () => {
  const source = Schema.Struct({ n: Schema.Number });
  const plain = deriveAuthoringAst(source.ast, { partial: true, slotFor });
  const native = deriveAuthoringAst(source.ast, {
    partial: true,
    slotFor,
    directives: true,
    nativeDirectives: true,
  });
  expect(plain).not.toBe(native);
  expect(Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown>>(native))({ n: reset() })._tag).toBe(
    "Success",
  );
  expect(Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown>>(plain))({ n: reset() })._tag).toBe(
    "Failure",
  );
  expect(AST.isSuspend(native) && native.checks !== undefined).toBe(false);
});

test("defers expressions nested in arrays and projects directives inside array members", () => {
  const source = Schema.Array(Schema.Struct({ n: Schema.Number })).check(
    Schema.makeFilter((values) => values.every(({ n }) => n > 0) || "Expected positive entries"),
  );
  const schema = Schema.make<Schema.Codec<unknown>>(
    deriveAuthoringAst(source.ast, {
      partial: true,
      slotFor,
      directives: true,
      nativeDirectives: true,
    }),
  );
  expect(Schema.decodeUnknownResult(schema)([{ n: expression("number") }], options)._tag).toBe("Success");
  expect(Schema.decodeUnknownResult(schema)([{ n: override(1) }], options)._tag).toBe("Success");
  expect(Schema.decodeUnknownResult(schema)([{ n: override(-1) }], options)._tag).toBe("Failure");
  expect(Schema.decodeUnknownResult(schema)([{ n: reset() }], options)._tag).toBe("Success");
});
