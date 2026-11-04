import { expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { data } from "@actions/expressions";
import { kindStr } from "@actions/expressions/data/expressiondata";
import { Effect } from "effect";
import {
  UnavailableContext,
  evaluateExpression,
  expressionDataFromUnknownSync,
  validateExpression,
} from "../src/language/expressions.ts";

const source = { file: "ci.yml", line: 2 };
const run = (text: string, context = new data.Dictionary()) =>
  Effect.runPromise(evaluateExpression(text, context, source));
it.each([
  ["null == 0", true],
  ["'TRUE' == 'true'", true],
  ["'' || 'fallback'", "fallback"],
  ["0 && 'other'", 0],
  ["contains(fromJSON('[\"One\"]'), 'one')", true],
])("preserves upstream semantics: %s", async (text, expected) => {
  expect(JSON.parse(JSON.stringify(await run(text), data.replacer))).toEqual(expected);
});
it("preserves object identity and object filters", async () => {
  const object = new data.Dictionary({ key: "a", value: new data.StringData("first") });
  const context = new data.Dictionary({ key: "obj", value: object });
  expect((await run("obj == obj", context)).coerceString()).toBe("true");
  expect((await run("join(obj.*, ',')", context)).coerceString()).toBe("first");
});
it("validates syntax independently and resolves unavailable roots lazily", async () => {
  class Lazy extends data.Dictionary {
    override get(): data.ExpressionData {
      throw new UnavailableContext();
    }
  }
  const options = { contextNames: ["steps"] };
  expect(
    (
      await Effect.runPromise(evaluateExpression("true || steps.x", new Lazy(), source, options))
    ).coerceString(),
  ).toBe("true");
  expect(
    (await Effect.runPromise(Effect.flip(evaluateExpression("steps.x", new Lazy(), source, options)))).code,
  ).toBe("context-unavailable");
  expect((await Effect.runPromise(Effect.flip(validateExpression("true || (", source, options)))).code).toBe(
    "expression-syntax",
  );
});
it("rejects expansion before nested format allocation and scans JSON before parsing", async () => {
  const text = "format('{0}{0}{0}{0}', format('{0}{0}{0}{0}', '1234567890'))";
  const result = await Effect.runPromise(
    Effect.flip(evaluateExpression(text, new data.Dictionary(), source, { limits: { valueBytes: 100 } })),
  );
  expect(result.code).toBe("expression-limit");
  const deep = `fromJSON('${"[".repeat(40)}0${"]".repeat(40)}')`;
  expect(
    (
      await Effect.runPromise(
        Effect.flip(evaluateExpression(deep, new data.Dictionary(), source, { limits: { valueDepth: 20 } })),
      )
    ).code,
  ).toBe("expression-limit");
});
it("bounds AST work, context cycles, and reports no raw expression", async () => {
  const context = new data.Dictionary();
  context.add("self", context);
  expect((await Effect.runPromise(Effect.flip(evaluateExpression("'PRIVATE'", context, source)))).code).toBe(
    "expression-limit",
  );
  const error = await Effect.runPromise(
    Effect.flip(evaluateExpression("format('PRIVATE{')", new data.Dictionary(), source)),
  );
  expect(JSON.stringify(error)).not.toContain("PRIVATE");
});

interface CorpusCase {
  expr: string;
  contexts?: unknown;
  result?: { kind: string; value: unknown };
  err?: { kind: string };
  options?: { skip?: string[] };
}
const fixtures = new URL("./fixtures/actions-language/expressions/", import.meta.url);
for (const file of readdirSync(fixtures).sort()) {
  const cases = JSON.parse(readFileSync(new URL(file, fixtures), "utf8")) as Record<string, CorpusCase[]>;
  for (const [name, rows] of Object.entries(cases))
    for (const [index, row] of rows.entries()) {
      const title = `upstream ${file} ${name} ${index}`;
      if (row.options?.skip?.includes("typescript")) {
        it.skip(title, () => {});
        continue;
      }
      it(title, async () => {
        const context =
          row.contexts === undefined
            ? new data.Dictionary()
            : (JSON.parse(JSON.stringify(row.contexts), data.reviver) as data.Dictionary);
        const result = await Effect.runPromise(Effect.result(evaluateExpression(row.expr, context, source)));
        if (row.err !== undefined) {
          expect(result._tag).toBe("Failure");
          return;
        }
        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        const expected = row.result;
        if (expected === undefined) throw new Error("missing corpus result");
        expect(kindStr(result.success.kind)).toEqual(expected.kind);
        expect(JSON.stringify(result.success, data.replacer)).toEqual(JSON.stringify(expected.value));
      });
    }
}

it("admits plain values without invoking accessors and preserves shared identity", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "private", {
    enumerable: true,
    get() {
      reads++;
      return "secret";
    },
  });
  expect(() => expressionDataFromUnknownSync(accessor)).toThrow();
  expect(reads).toBe(0);
  expect(() => expressionDataFromUnknownSync(new Date())).toThrow();
  expect(() =>
    expressionDataFromUnknownSync({ nested: "😀".repeat(100) }, { limits: { valueBytes: 100 } }),
  ).toThrow();
  const shared = { value: 1 };
  const converted = expressionDataFromUnknownSync({ one: shared, two: shared });
  expect(converted).toBeInstanceOf(data.Dictionary);
  if (converted instanceof data.Dictionary) expect(converted.get("one")).toBe(converted.get("two"));
  expect(() => expressionDataFromUnknownSync({}, { limits: { valueNodes: 50_001 } })).toThrow();
});
it("retains unavailable sentinel inside an index expression and enforces work quotas", async () => {
  class Lazy extends data.Dictionary {
    override get(): data.ExpressionData {
      throw new UnavailableContext();
    }
  }
  const result = await Effect.runPromise(
    Effect.flip(
      evaluateExpression("fromJSON('[]')[steps.x]", new Lazy(), source, { contextNames: ["steps"] }),
    ),
  );
  expect(result.code).toBe("context-unavailable");
  expect(
    (
      await Effect.runPromise(
        Effect.flip(
          evaluateExpression("true && true", new data.Dictionary(), source, { limits: { work: 2 } }),
        ),
      )
    ).code,
  ).toBe("expression-limit");
});
