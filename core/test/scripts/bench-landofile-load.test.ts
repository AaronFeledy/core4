import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { fixtureNames, readBaseline } from "../../../scripts/bench-landofile-load.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const baselinePath = join(repoRoot, "scripts/bench-baselines.json");
const Summary = Schema.Struct({
  ok: Schema.Boolean,
  fixtures: Schema.Array(
    Schema.Struct({
      fixture: Schema.String,
      runs: Schema.Number,
      warmups: Schema.Number,
      medianMs: Schema.Number,
      p95Ms: Schema.Number,
      finalizations: Schema.Number,
      layerDecodes: Schema.Number,
      ok: Schema.Boolean,
    }),
  ),
});

describe("bench-landofile-load", () => {
  test("tracks measured median and tail budgets for every load fixture", async () => {
    // Given / When
    const baseline = await readBaseline(baselinePath);
    // Then
    expect(Object.keys(baseline.fixtures)).toEqual([...fixtureNames]);
    expect(baseline.runs).toBe(30);
    expect(baseline.allowedRegressionPercent).toBe(25);
    for (const timing of Object.values(baseline.fixtures)) {
      expect(timing.medianMs).toBeGreaterThan(0);
      expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.medianMs);
    }
  });

  test.each([
    { budget: 100_000, exitCode: 0, ok: true },
    { budget: 0.000001, exitCode: 1, ok: false },
  ])("compares real loader timings against a $budget ms baseline", async ({ budget, exitCode, ok }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-load-bench-test-"));
    try {
      const baseline = await readBaseline(baselinePath);
      const path = join(root, "baseline.json");
      await Bun.write(
        path,
        JSON.stringify({
          landofileLoad: {
            ...baseline,
            fixtures: { ...baseline.fixtures, "one-layer": { medianMs: budget, p95Ms: budget } },
          },
        }),
      );
      // When
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          "scripts/bench-landofile-load.ts",
          "--json",
          "--runs=1",
          "--fixture=one-layer",
          "--baseline",
          path,
        ],
        cwd: repoRoot,
        env: { ...process.env, TMPDIR: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then
      expect(stderr).toBe("");
      expect(code).toBe(exitCode);
      const result = Schema.decodeUnknownSync(Summary)(JSON.parse(stdout));
      expect(result.ok).toBe(ok);
      expect(result.fixtures).toHaveLength(1);
      expect(result.fixtures[0]).toMatchObject({
        fixture: "one-layer",
        runs: 1,
        warmups: 3,
        finalizations: 1,
        layerDecodes: 0,
        ok,
      });
      expect(result.fixtures[0]?.medianMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
