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
import { Result, Schema, SchemaAST, SchemaIssue } from "effect";

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
  { type: "noSuchFilter" },
])("reports only the selected route-filter member for %j", (filter) => {
  // Given
  const input = { services: { web: { routes: [{ hostname: "web.test", filters: [filter] }] } } };
  // When
  const messages = issues(LandofileAuthoringFragmentNative, input);
  // Then
  expect(messages).toEqual(issues(LandofileShape, input));
  expect(messages).toHaveLength(1);
});

test.each([
  [Schema.Literal("web"), 'Expected "web"'],
  [Schema.Enum({ web: "web", worker: "worker" }), 'Expected "web" | "worker"'],
  [
    Schema.Union([Schema.TemplateLiteral(["x-", Schema.String]), Schema.Boolean]),
    "Expected a matching string | boolean",
  ],
  [Schema.suspend(() => Schema.String), "Expected string"],
  [
    Schema.Union([Schema.NumberFromString, Schema.Boolean]),
    "Expected a string that will be decoded as a number | boolean",
  ],
  [
    Schema.declare((value): value is string => typeof value === "string", {
      identifier: "OpaqueName",
      expected: "an opaque token",
    }),
    "Expected an opaque token",
  ],
] as const)("renders structural expectations for %j", (schema, message) => {
  // Given / When
  const messages = issues(schema, null);
  // Then
  expect(messages).toEqual([{ path: [], message }]);
});

test("bounds a suspended expectation cycle without leaking its identifier", () => {
  // Given a diagnostic AST rather than a decoder that cannot terminate.
  const recursive: SchemaAST.Suspend = new SchemaAST.Suspend(() => recursive, {
    identifier: "RecursiveName",
  });
  const issue = new SchemaIssue.InvalidType(recursive, null);
  // When
  const messages = validationIssuesFromSchemaIssue(issue);
  // Then
  expect(messages).toEqual([{ path: [], message: "Expected a value" }]);
});

test.each([
  [
    Schema.Union([Schema.Literals(["daily", "weekly"]), Schema.String.check(Schema.isPattern(/^every_/))]),
    "sometimes",
    [{ path: [], message: "Choose a pull policy" }],
  ],
  [
    Schema.Union([
      Schema.String.check(Schema.isMinLength(1, { message: "A command is required" })),
      Schema.Number,
    ]),
    "",
    [{ path: [], message: "A command is required" }],
  ],
  [
    Schema.Union([Schema.Struct({ command: Schema.String }), Schema.Number]),
    { command: false },
    [{ path: ["command"], message: "Expected string" }],
  ],
  [
    Schema.Union([Schema.String.annotate({ message: "Use text" }), Schema.Number]),
    false,
    [{ path: [], message: "Choose a pull policy" }],
  ],
] as const)(
  "summarizes only value-level union failures without candidate messages for %j",
  (members, input, expected) => {
    // Given
    const source = members.annotate({ message: "Choose a pull policy" });
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
    const effective = issues(source, input);
    const authored = issues(fragment, input);
    // Then
    expect(effective).toEqual(expected);
    expect(authored).toEqual(expected);
  },
);

test("explains a forbidden key without changing its rejection", () => {
  // Given
  const schema = Schema.Struct({ task: Schema.optionalKey(Schema.Never) });
  // When
  const messages = issues(schema, { task: "build" });
  // Then
  expect(messages).toEqual([{ path: ["task"], message: "This key is not allowed here" }]);
});

test("omits Never alternatives from union expectations", () => {
  // Given
  const ast = new SchemaAST.Union([Schema.Never.ast, Schema.String.ast]);
  // When
  const messages = validationIssuesFromSchemaIssue(new SchemaIssue.AnyOf(ast, [], false));
  // Then
  expect(messages).toEqual([{ path: [], message: "Expected string" }]);
});

test("preserves an explicit forbidden-key message", () => {
  // Given
  const schema = Schema.Struct({
    task: Schema.optionalKey(Schema.Never.annotate({ message: "Choose cmd or task, not both" })),
  });
  // When
  const messages = issues(schema, { task: "build" });
  // Then
  expect(messages).toEqual([{ path: ["task"], message: "Choose cmd or task, not both" }]);
});
