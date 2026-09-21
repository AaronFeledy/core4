import { expect, test } from "bun:test";

import {
  LIVE_OUTPUT_ENV,
  drainStream,
  guideScenarioTestArgs,
  liveOutputEnabled,
} from "./run-guide-scenarios.ts";

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
