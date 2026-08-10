import { expect, test } from "bun:test";

import { guideScenarioTestArgs } from "./run-guide-scenarios.ts";

test("guide scenario runner caps concurrency unless the caller already chose a cap", () => {
  expect(guideScenarioTestArgs(["generated.test.ts"])).toEqual(["generated.test.ts", "--max-concurrency=1"]);
  expect(guideScenarioTestArgs(["generated.test.ts", "--max-concurrency=2"])).toEqual([
    "generated.test.ts",
    "--max-concurrency=2",
  ]);
  expect(guideScenarioTestArgs(["generated.test.ts", "--max-concurrency", "3"])).toEqual([
    "generated.test.ts",
    "--max-concurrency",
    "3",
  ]);
});
