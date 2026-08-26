import { run } from "@gabrielbryk/jq-ts";

import type { JqEngine } from "./types.ts";

const LIMITS = {
  maxSteps: 1_000_000,
  maxDepth: 200,
  maxOutputs: 100_000,
} as const;

export const jqTsEngine: JqEngine = {
  async eval(input, expr) {
    const results = run(expr, input, { limits: LIMITS, now: 0 });
    return { text: results.map((value) => JSON.stringify(value)).join("\n") };
  },
};
