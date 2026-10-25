import { expect, test } from "bun:test";
import {
  AppPlan,
  GlobalConfig,
  LandofileAuthoringFragmentNative,
  LandofileShape,
  RecipeManifest,
  authoringExpressionSlot,
  deriveAuthoringAst,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const issues = (schema: Schema.ConstraintDecoder<unknown, never>, input: unknown) => {
  const result = Schema.decodeUnknownResult(schema)(input, { errors: "all", onExcessProperty: "error" });
  if (Result.isSuccess(result)) throw new Error("Expected schema failure");
  return validationIssuesFromSchemaIssue(result.failure.issue);
};

test.each([
  ["Landofile", LandofileShape],
  ["global config", GlobalConfig],
  ["recipe manifest", RecipeManifest],
  ["plan", AppPlan],
] as const)("renders an identifier-bearing %s structurally", (_name, schema) => {
  // Given / When
  const messages = issues(schema, false);
  // Then
  expect(messages).toEqual([{ path: [], message: "Expected object" }]);
});

test("keeps a selected discriminator's real check failure without sibling noise", () => {
  // Given
  const source = Schema.Union([
    Schema.Struct({
      type: Schema.Literal("web").check(
        Schema.makeFilter(() => false, { message: "This filter is unavailable." }),
      ),
    }),
    Schema.Struct({ type: Schema.Literal("worker"), count: Schema.Number }),
  ]);
  const fragment = Schema.make<Schema.Codec<unknown>>(
    deriveAuthoringAst(source.ast, {
      partial: true,
      rootExpression: false,
      directives: true,
      nativeDirectives: true,
      slotFor: (kind) => authoringExpressionSlot(kind).ast,
    }),
  );
  // When
  const messages = issues(fragment, { type: "web" });
  // Then
  expect(messages).toEqual(issues(source, { type: "web" }));
  expect(messages).toHaveLength(1);
});

test("keeps discriminator-free route fragments partial", () => {
  // Given
  const input = { services: { web: { routes: [{ filters: [{ prefix: "/api" }] }] } } };
  // When
  const result = Schema.decodeUnknownResult(LandofileAuthoringFragmentNative)(input, {
    errors: "all",
    onExcessProperty: "error",
  });
  // Then
  expect(Result.isSuccess(result)).toBe(true);
});

test.each([
  [Schema.String.annotate({ identifier: "PrivateName", expected: "a short name" }), "Expected a short name"],
  [
    Schema.String.annotate({ identifier: "PrivateName", expected: "a short name", message: "Use a name." }),
    "Use a name.",
  ],
  [
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.Number),
      Schema.Struct({ kind: Schema.Literal("web") }),
    ]).annotate({ identifier: "PrivateUnion" }),
    "Expected string | array | object",
  ],
  [Schema.NumberFromString, "Expected a string that will be decoded as a number"],
] as const)("uses message, expected, or structural input kinds for %j", (schema, message) => {
  // Given / When
  const messages = issues(schema, null);
  // Then
  expect(messages).toEqual([{ path: [], message }]);
});

test.each([
  { type: "stripPrefix", prefix: 5 },
  { type: "addPrefix", prefix: 5 },
  { type: "requestHeader", header: "X-Test", value: 5 },
  { type: "responseHeader", header: "X-Test", value: 5 },
  { type: "redirect", to: 5 },
])("reports only the selected route-filter member for %j", (filter) => {
  // Given
  const input = { services: { web: { routes: [{ hostname: "web.test", filters: [filter] }] } } };
  // When
  const messages = issues(LandofileAuthoringFragmentNative, input);
  // Then
  expect(messages).toEqual(issues(LandofileShape, input));
  expect(messages).toHaveLength(1);
});
