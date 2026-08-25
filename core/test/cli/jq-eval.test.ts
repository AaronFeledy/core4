import { describe, expect, test } from "bun:test";

import { applyJqToRedactedJsonLine } from "../../src/cli/jq/eval.ts";
import type { JqEngine } from "../../src/cli/jq/types.ts";

const envelope = { ok: true, result: { n: 1 } } as const;
const envelopeLine = JSON.stringify(envelope);

const fake = (text: string): JqEngine => ({
  eval: async () => ({ text }),
});

describe("applyJqToRedactedJsonLine with a fake engine", () => {
  test("prints true when .ok is applied to a mini envelope", async () => {
    const engine: JqEngine = {
      eval: async (input, expr) => {
        expect(input).toEqual(envelope);
        expect(expr).toBe(".ok");
        return { text: "true" };
      },
    };

    const out = await applyJqToRedactedJsonLine(envelopeLine, ".ok", engine);

    expect(out).toBe("true");
  });

  test("prints a top-level number without JSON quotes", async () => {
    const out = await applyJqToRedactedJsonLine(envelopeLine, ".result.n", fake("1"));
    expect(out).toBe("1");
  });

  test("prints a top-level string without JSON quotes", async () => {
    const out = await applyJqToRedactedJsonLine(envelopeLine, ".name", fake(JSON.stringify("web")));
    expect(out).toBe("web");
  });

  test("prints a top-level boolean and null without JSON quotes", async () => {
    expect(await applyJqToRedactedJsonLine(envelopeLine, ".ok", fake("false"))).toBe("false");
    expect(await applyJqToRedactedJsonLine("null", ".", fake("null"))).toBe("null");
  });

  test("prints composites as compact JSON", async () => {
    const out = await applyJqToRedactedJsonLine(
      envelopeLine,
      ".result",
      fake(JSON.stringify({ n: 1 }, null, 2)),
    );
    expect(out).toBe('{"n":1}');
  });

  test("throws JqExpressionError timeout when the engine never resolves", async () => {
    const hung: JqEngine = {
      eval: () => new Promise(() => {}),
    };

    try {
      await applyJqToRedactedJsonLine(envelopeLine, ".", hung);
      expect.unreachable("expected timeout");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "JqExpressionError",
        reason: "timeout",
        expression: ".",
      });
    }
  }, 10_000);

  test("throws JqExpressionError too_large when formatted output exceeds 8 MiB", async () => {
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    try {
      await applyJqToRedactedJsonLine(envelopeLine, ".", fake(oversized));
      expect.unreachable("expected too_large");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "JqExpressionError",
        reason: "too_large",
        expression: ".",
      });
    }
  });

  test("throws JqExpressionError eval when the engine rejects", async () => {
    const engine: JqEngine = {
      eval: async () => {
        throw new Error("jq: compile error");
      },
    };

    try {
      await applyJqToRedactedJsonLine(envelopeLine, ".[", engine);
      expect.unreachable("expected eval error");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "JqExpressionError",
        reason: "eval",
        expression: ".[",
      });
    }
  });
});

describe("applyJqToRedactedJsonLine with jq-wasm", () => {
  test("prints 1 when .result.n is applied to a mini envelope", async () => {
    const out = await applyJqToRedactedJsonLine(envelopeLine, ".result.n");
    expect(out).toBe("1");
  });

  test("throws JqExpressionError when the expression is invalid", async () => {
    try {
      await applyJqToRedactedJsonLine(envelopeLine, ".[");
      expect.unreachable("expected eval error");
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "JqExpressionError",
        reason: "eval",
        expression: ".[",
      });
    }
  });
});
