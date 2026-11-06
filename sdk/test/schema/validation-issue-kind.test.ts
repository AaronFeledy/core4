import { expect, test } from "bun:test";
import { validationIssuesFromSchemaIssue } from "@lando/sdk/schema";
import { Result, Schema, SchemaIssue } from "effect";

test.each([
  [Schema.Number, "1", "type"],
  [Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 65535 })), 99999999, "value"],
  [Schema.Literal("one"), "two", "value"],
  [Schema.Literal("one"), 1, "type"],
  [Schema.Literals(["one", "two"]), "three", "value"],
  [Schema.Literals(["one", "two"]), false, "type"],
  [Schema.Enum({ One: "one", Two: "two" }), "three", "value"],
  [Schema.Enum({ One: "one", Two: "two" }), 3, "type"],
  [Schema.Enum({ Low: 1, High: 2 }), 3, "value"],
  [Schema.Never, "build", "unexpected"],
  [Schema.Union([Schema.String, Schema.Number]), false, "type"],
  [Schema.Union([Schema.String, Schema.Number.check(Schema.isGreaterThan(0))]), -1, "value"],
  [Schema.Union([Schema.Literal(false), Schema.Number.check(Schema.isGreaterThan(0))]), true, "value"],
  [
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("a") }),
      Schema.Struct({ type: Schema.Literal("b") }),
    ]),
    { type: "c" },
    "value",
  ],
] as const)("classifies %s rejecting %j as %s without reported input", (schema, input, kind) => {
  const decoded = Schema.decodeUnknownResult(Schema.Struct({ value: schema }))(
    { value: input },
    { reportInput: false },
  );
  expect(Result.isFailure(decoded)).toBe(true);
  if (Result.isFailure(decoded)) {
    const issues = validationIssuesFromSchemaIssue(decoded.failure.issue, { input: { value: input } });
    expect(issues.map(({ path, kind }) => ({ path, kind }))).toEqual([{ path: ["value"], kind }]);
  }
});

test("retains key-presence kinds", () => {
  const decoded = Schema.decodeUnknownResult(Schema.Struct({ required: Schema.String }))(
    { extra: 1 },
    { errors: "all", onExcessProperty: "error" },
  );
  expect(Result.isFailure(decoded)).toBe(true);
  if (Result.isFailure(decoded)) {
    expect(
      validationIssuesFromSchemaIssue(decoded.failure.issue).map(({ path, kind }) => ({ path, kind })),
    ).toEqual([
      { path: ["extra"], kind: "unexpected" },
      { path: ["required"], kind: "missing" },
    ]);
  }
});

test("omits an indeterminate literal-union kind", () => {
  const issue = new SchemaIssue.AnyOf(Schema.Literals(["a", "b"]).ast, []);
  expect(validationIssuesFromSchemaIssue(issue)[0]).not.toHaveProperty("kind");
});

test("uses reported input to classify a literal union", () => {
  const issue = new SchemaIssue.AnyOf(Schema.Literals(["a", "b"]).ast, [], false, { reportInput: true });
  expect(validationIssuesFromSchemaIssue(issue)[0]?.kind).toBe("type");
});

test("classifies explicit invalid values and forbidden decodes as value failures", () => {
  expect(validationIssuesFromSchemaIssue(new SchemaIssue.InvalidValue())[0]?.kind).toBe("value");
  expect(validationIssuesFromSchemaIssue(new SchemaIssue.Forbidden(undefined))[0]?.kind).toBe("value");
});
