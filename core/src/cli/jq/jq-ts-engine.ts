import { parse, runAst, type Value } from "@gabrielbryk/jq-ts";

import type { JqEngine } from "./types.ts";
import { assertJqExpressionSafe } from "./jq-ts-guard.ts";

const LIMITS = {
  maxSteps: 1_000_000,
  maxDepth: 200,
  maxOutputs: 100_000,
} as const;

const isJqValue = (input: unknown): input is Value => {
  if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") {
    return true;
  }
  if (Array.isArray(input)) {
    return input.every(isJqValue);
  }
  if (typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
    return Object.values(input).every(isJqValue);
  }
  return false;
};

export const jqTsEngine: JqEngine = {
  async eval(input, expr) {
    if (!isJqValue(input)) {
      throw new Error("jq input is not JSON");
    }
    const ast = parse(expr);
    assertJqExpressionSafe(ast);
    // now is injected because jq-ts never reads the host clock.
    const results = runAst(ast, input, { limits: LIMITS, now: Date.now() / 1000 });
    return { text: results.map((value) => JSON.stringify(value)).join("\n") };
  },
};
