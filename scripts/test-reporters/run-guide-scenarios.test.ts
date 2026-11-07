import { expect, test } from "bun:test";

import {
  LIVE_OUTPUT_ENV,
  drainStream,
  guideScenarioTestArgs,
  liveOutputEnabled,
} from "./run-guide-scenarios.ts";

test("guide scenarios use CPU-sized isolated workers and preserve a caller's test concurrency", () => {
  expect(guideScenarioTestArgs(["generated.test.ts"], {}, 4)).toEqual([
    "generated.test.ts",
    "--max-concurrency=1",
    "--parallel=4",
  ]);
  expect(guideScenarioTestArgs(["generated.test.ts", "--max-concurrency=2"], {}, 4)).toEqual([
    "generated.test.ts",
    "--max-concurrency=2",
    "--parallel=4",
  ]);
  expect(guideScenarioTestArgs(["generated.test.ts", "--max-concurrency", "3"], {}, 4)).toEqual([
    "generated.test.ts",
    "--max-concurrency",
    "3",
    "--parallel=4",
  ]);
});

test.each([1, 2, 8, 24])("guide worker count is bounded by available CPUs (%s) and eight workers", (cpus) => {
  expect(guideScenarioTestArgs([], {}, cpus)).toContain(`--parallel=${Math.min(8, cpus)}`);
});

test("guide scenarios preserve an explicit worker count", () => {
  expect(guideScenarioTestArgs(["--parallel=2"], {}, 4)).toEqual(["--parallel=2", "--max-concurrency=1"]);
});

test.each([
  { args: [], env: { LANDO_GUIDE_E2E: "1" } },
  { args: ["--test-name-pattern=@smoke.*\\[e2e\\]"], env: {} },
  { args: ["--test-name-pattern", "\\[e2e\\]"], env: {} },
  { args: ["-t", "[e2e]"], env: {} },
])("e2e guide runs force one worker and one test even with caller overrides: %j", ({ args, env }) => {
  const result = guideScenarioTestArgs([...args, "--parallel=8", "--max-concurrency=3"], env, 4);
  expect(result.slice(-2)).toEqual(["--parallel=1", "--max-concurrency=1"]);
});

test("live output is enabled only by LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1", () => {
  expect(LIVE_OUTPUT_ENV).toBe("LANDO_GUIDE_SCENARIO_LIVE_OUTPUT");
  expect(liveOutputEnabled({})).toBe(false);
  expect(liveOutputEnabled({ [LIVE_OUTPUT_ENV]: "" })).toBe(false);
  expect(liveOutputEnabled({ [LIVE_OUTPUT_ENV]: "true" })).toBe(false);
  expect(liveOutputEnabled({ [LIVE_OUTPUT_ENV]: "1" })).toBe(true);
});

test("drainStream tees every chunk as it arrives and returns the full decoded text", async () => {
  // Given: 14 UTF-8 bytes, with é split between the first two chunks.
  const bytes = new TextEncoder().encode("héllo\nwörld\n");
  const chunks = [bytes.slice(0, 2), bytes.slice(2, 7), bytes.slice(7)];
  const source = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const seen: number[] = [];
  // When: draining with a tee, then without one.
  const text = await drainStream(source(), (chunk: Uint8Array) => {
    seen.push(chunk.byteLength);
  });
  const buffered = await drainStream(source(), null);
  // Then: chunk order and decoded bytes are preserved in both modes.
  expect(text).toBe("héllo\nwörld\n");
  expect(seen).toEqual([2, 5, 7]);
  expect(buffered).toBe("héllo\nwörld\n");
});
