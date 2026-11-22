import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LIVE_OUTPUT_ENV,
  drainStream,
  expandSmokeE2e,
  guideScenarioTestArgs,
  isSmokeE2eScenario,
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

const header = (tags: string, layer: string): string =>
  `// @generated\n// @source: docs/guides/x.mdx:1\n// @scenario: s\n// @variant:\n// @tags: ${tags}\n${layer}\n`;

test.each([
  { tags: "docs,node,@smoke", layer: "// @layer: e2e", smokeE2e: true },
  { tags: "@smoke", layer: "// @layer: e2e", smokeE2e: true },
  { tags: "docs,node", layer: "// @layer: e2e", smokeE2e: false },
  { tags: "docs,@smoke-later", layer: "// @layer: e2e", smokeE2e: false },
  { tags: "docs,@smoke", layer: "", smokeE2e: false },
])("only @smoke scenarios on the e2e layer are smoke e2e: %j", ({ tags, layer, smokeE2e }) => {
  expect(isSmokeE2eScenario(header(tags, layer))).toBe(smokeE2e);
});

test("--smoke-e2e expands to the sorted smoke e2e files and keeps the caller's other arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "guide-smoke-e2e-"));
  try {
    const files = {
      "test/scenarios/generated/guides/node/dev-engines.test.ts": header("docs,@smoke", "// @layer: e2e"),
      "test/scenarios/generated/guides/adminer/browse.test.ts": header("@smoke", "// @layer: e2e"),
      "test/scenarios/generated/guides/adminer/plan.test.ts": header("@smoke", ""),
      "test/scenarios/generated/guides/node/full.test.ts": header("docs", "// @layer: e2e"),
    };
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }

    expect(await expandSmokeE2e(["--smoke-e2e", "--shard=2/2"], root)).toEqual([
      "./test/scenarios/generated/guides/adminer/browse.test.ts",
      "./test/scenarios/generated/guides/node/dev-engines.test.ts",
      "--test-name-pattern=@smoke.*\\[e2e\\]",
      "--shard=2/2",
    ]);
    expect(await expandSmokeE2e(["generated.test.ts"], root)).toEqual(["generated.test.ts"]);
    await expect(expandSmokeE2e(["--smoke-e2e", "--shard=1/3"], root)).rejects.toThrow(
      "found 2 @smoke [e2e] scenarios for 3 shards",
    );
    await rm(join(root, "test/scenarios/generated/guides/adminer/browse.test.ts"));
    await rm(join(root, "test/scenarios/generated/guides/node/dev-engines.test.ts"));
    await expect(expandSmokeE2e(["--smoke-e2e"], root)).rejects.toThrow("found no @smoke [e2e] scenarios");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
