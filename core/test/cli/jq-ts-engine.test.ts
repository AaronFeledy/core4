import { describe, expect, test } from "bun:test";

import { jqTsEngine } from "../../src/cli/jq/jq-ts-engine.ts";

describe("jqTsEngine", () => {
  test("stringifies a field lookup as JSON", async () => {
    const result = await jqTsEngine.eval({ a: 1 }, ".a");
    expect(result.text.trim()).toBe("1");
  });

  test("injects host now as seconds since epoch", async () => {
    const before = Date.now() / 1000;
    const result = await jqTsEngine.eval(null, "now");
    const after = Date.now() / 1000;
    const value = Number(result.text.trim());
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(before - 5);
    expect(value).toBeLessThanOrEqual(after + 5);
  });

  test("rejects unbounded index assignment in under 2s", async () => {
    const started = Date.now();
    let thrown: unknown;
    try {
      await jqTsEngine.eval([], ".[999999999] = 0");
    } catch (error) {
      thrown = error;
    }
    expect(Date.now() - started).toBeLessThan(2000);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/unbounded/);
  }, 5000);

  test("rejects or returns huge range in under 5s", async () => {
    const started = Date.now();
    try {
      await jqTsEngine.eval(null, "[range(100000000)]");
    } catch {
      // jq-ts limits or the hang guard may reject; either is acceptable
    }
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);
});
