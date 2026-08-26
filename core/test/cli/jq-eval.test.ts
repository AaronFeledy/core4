import { describe, expect, test } from "bun:test";

import { JqExpressionError } from "@lando/sdk/errors";

import { applyJqToRedactedJsonLine } from "../../src/cli/jq/eval.ts";
import type { JqEngine } from "../../src/cli/jq/types.ts";

const envelope = { ok: true, result: { n: 1 } } as const;
const envelopeLine = JSON.stringify(envelope);

const fake = (text: string): JqEngine => ({
  eval: async () => ({ text }),
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const withUnhandledRejectionProbe = async (run: () => Promise<void>): Promise<readonly unknown[]> => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  const emitter = process as NodeJS.EventEmitter;
  emitter.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await delay(100);
    return rejections;
  } finally {
    emitter.off("unhandledRejection", onUnhandled);
  }
};

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

  test("does not emit unhandledRejection when the engine rejects after timeout", async () => {
    const lateReject: JqEngine = {
      eval: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("late engine failure"));
          }, 50);
        }),
    };

    const rejections = await withUnhandledRejectionProbe(async () => {
      try {
        await applyJqToRedactedJsonLine(envelopeLine, ".", lateReject, 20);
        expect.unreachable("expected timeout");
      } catch (error) {
        expect(error).toMatchObject({
          _tag: "JqExpressionError",
          reason: "timeout",
          expression: ".",
        });
      }
    });

    expect(rejections).toEqual([]);
  });

  test("does not emit unhandledRejection when the engine resolves after timeout", async () => {
    const lateResolve: JqEngine = {
      eval: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ text: "late" });
          }, 50);
        }),
    };

    const rejections = await withUnhandledRejectionProbe(async () => {
      try {
        await applyJqToRedactedJsonLine(envelopeLine, ".", lateResolve, 20);
        expect.unreachable("expected timeout");
      } catch (error) {
        expect(error).toMatchObject({
          _tag: "JqExpressionError",
          reason: "timeout",
          expression: ".",
        });
      }
    });

    expect(rejections).toEqual([]);
  });

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

describe("applyJqToRedactedJsonLine with the default engine", () => {
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

  test("settles a huge range in under 5s", async () => {
    const started = Date.now();
    let thrown: unknown;
    let result: string | undefined;
    try {
      result = await applyJqToRedactedJsonLine('{"a":1}', "[range(100000000)]");
    } catch (error) {
      thrown = error;
    }
    expect(Date.now() - started).toBeLessThan(5000);
    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(JqExpressionError);
    } else {
      expect(typeof result).toBe("string");
    }
  }, 10_000);

  test("rejects unbounded index assignment in under 2s", async () => {
    const started = Date.now();
    try {
      await applyJqToRedactedJsonLine("{}", ".[999999999] = 0");
      expect.unreachable("expected eval error");
    } catch (error) {
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error).toBeInstanceOf(JqExpressionError);
      expect(error).toMatchObject({
        reason: "eval",
        detail: expect.stringMatching(/unbounded index or allocation/),
      });
    }
  }, 5_000);
});
