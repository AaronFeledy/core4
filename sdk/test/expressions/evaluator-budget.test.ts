import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";

import {
  ExpressionContext,
  type ExpressionNode,
  evaluateExpression,
  evaluateExpressionEither,
  evaluateTemplate,
  evaluateTemplateEither,
  parseExpressionEither,
} from "@lando/sdk/expressions";

const budget = { maxSteps: 100000, maxDepth: 100, maxOutputBytes: 1000000, maxCollectionSize: 10000 };
const parseTemplate = (source: string) => {
  const result = parseExpressionEither(source, { filePath: "/app/.lando.yml" });
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};
const expression = (source: string): ExpressionNode => {
  const segment = parseTemplate(source).segments[0];
  if (segment?.kind !== "InterpolationSegment") throw new Error("expected interpolation segment");
  return segment.expression;
};
const expectBudgetFailure = (
  result: ReturnType<typeof evaluateExpressionEither>,
  limit: keyof typeof budget,
) => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) throw new Error("expected budget failure");
  expect(result.left._tag).toBe("LandofileExpressionEvalError");
  expect(result.left.message).toStartWith(`Expression budget exceeded (${limit})`);
};

describe("expression evaluation budgets", () => {
  test("options scope resolves from the supplied context", () => {
    const context = Schema.decodeUnknownSync(ExpressionContext)({ options: { db: "mysql" } });
    expect(evaluateTemplateEither(parseTemplate("{{ options.db }}"), context)).toEqual(Either.right("mysql"));
  });

  test("collection budget rejects an oversized range", () => {
    expectBudgetFailure(
      evaluateExpressionEither(expression("{{ range(0, 50000) }}"), {}, { budget }),
      "maxCollectionSize",
    );
  });

  test("depth budget rejects a deeply nested tree", () => {
    let node: ExpressionNode = { kind: "Literal", value: 0 };
    for (let index = 0; index < 30; index += 1) node = { kind: "ArrayLiteral", elements: [node] };
    expectBudgetFailure(
      evaluateExpressionEither(node, {}, { budget: { ...budget, maxDepth: 10 } }),
      "maxDepth",
    );
  });

  test("step budget rejects a long iteration", () => {
    expectBudgetFailure(
      evaluateExpressionEither(
        expression('{{ join(options.items, "") }}'),
        { options: { items: Array(30).fill("x") } },
        { budget: { ...budget, maxSteps: 10 } },
      ),
      "maxSteps",
    );
  });

  test("output budget rejects an oversized result", () => {
    expectBudgetFailure(
      evaluateTemplateEither(
        parseTemplate('{{ "😀😀😀" }}'),
        {},
        { budget: { ...budget, maxOutputBytes: 10 } },
      ),
      "maxOutputBytes",
    );
  });

  test("omitting the budget preserves current behaviour", () => {
    const result = evaluateExpressionEither(expression("{{ range(0, 50000) }}"), {});
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toEqual(Array.from({ length: 50000 }, (_, index) => index));
  });

  test.each([
    '{{ map(options.items, "upper") }}',
    '{{ filter(options.items, "not") }}',
    '{{ split("a,b,c,d", ",") }}',
    "{{ merge(options.record, {}) }}",
    "{{ entries(options.record) }}",
    "{{ keys(options.record) }}",
    "{{ values(options.record) }}",
    "{{ slice(options.items, 0) }}",
    "{{ range(4) }}",
  ])("counts collection work in %s", (source) => {
    expectBudgetFailure(
      evaluateExpressionEither(
        expression(source),
        {
          options: { items: ["a", "b", "c", "d"], record: { a: 1, b: 2, c: 3, d: 4 } },
        },
        { budget: { ...budget, maxSteps: 5 } },
      ),
      "maxSteps",
    );
  });

  test.each(["{{ [1, 2, 3] }}", "{{ {a: 1, b: 2, c: 3} }}", '{{ fromJson("[[1,2,3]]") }}'])(
    "checks literal and nested helper collections in %s",
    (source) => {
      expectBudgetFailure(
        evaluateExpressionEither(expression(source), {}, { budget: { ...budget, maxCollectionSize: 2 } }),
        "maxCollectionSize",
      );
    },
  );

  test("shares steps across template interpolations", () => {
    expectBudgetFailure(
      evaluateTemplateEither(
        parseTemplate("{{ 1 }} {{ 2 }} {{ 3 }}"),
        {},
        { budget: { ...budget, maxSteps: 2 } },
      ),
      "maxSteps",
    );
  });

  test("checks the complete mixed template output", () => {
    expectBudgetFailure(
      evaluateTemplateEither(
        parseTemplate("prefix {{ 1 }} suffix"),
        {},
        { budget: { ...budget, maxOutputBytes: 5 } },
      ),
      "maxOutputBytes",
    );
  });

  test("accepts exact limits and resets counters for each Effect execution", () => {
    const effect = evaluateExpression(
      expression("{{ [1] }}"),
      {},
      { budget: { maxSteps: 2, maxDepth: 2, maxCollectionSize: 1, maxOutputBytes: 3 } },
    );
    expect(Effect.runSync(effect)).toEqual([1]);
    expect(Effect.runSync(effect)).toEqual([1]);
  });

  test("Effect template entry reports tagged budget failures", () => {
    const result = Effect.runSync(
      Effect.either(
        evaluateTemplate(parseTemplate("plain text"), {}, { budget: { ...budget, maxOutputBytes: 2 } }),
      ),
    );
    expectBudgetFailure(result, "maxOutputBytes");
  });
});
