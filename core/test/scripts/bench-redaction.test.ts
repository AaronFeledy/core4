import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readBaseline } from "../../../scripts/bench-redaction.ts";
import { benchCaseNames } from "../../../scripts/bench-redaction-cases.ts";
import { CORPUS_LINE_COUNT, buildCorpus } from "../../../scripts/bench-redaction-corpus.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const baselinePath = join(repoRoot, "scripts/bench-baselines.json");

describe("bench-redaction", () => {
  test("records a measured budget for every benchmark case", async () => {
    // Given / When
    const baseline = await readBaseline(baselinePath);
    // Then
    expect(Object.keys(baseline.cases).sort()).toEqual([...benchCaseNames].sort());
    expect(baseline.runs).toBe(60);
    expect(baseline.warmups).toBe(3);
    expect(baseline.allowedRegressionPercent).toBe(25);
    for (const timing of Object.values(baseline.cases)) {
      expect(timing.medianMs).toBeGreaterThan(0);
      expect(timing.p95Ms).toBeGreaterThanOrEqual(timing.medianMs);
    }
  });

  test("builds a deterministic corpus containing every registered value", () => {
    // Given / When
    const first = buildCorpus();
    const second = buildCorpus();
    // Then the seed, shapes, and registered values are identical across builds.
    expect(first.lines).toHaveLength(CORPUS_LINE_COUNT);
    expect(first).toEqual(second);
    expect(first.values).toHaveLength(100);
    expect(first.wholeTokenValues).toHaveLength(100);
    for (const value of [...first.values, ...first.wholeTokenValues]) {
      expect(first.text).toContain(value);
    }
    expect(first.values.filter((value) => value.includes("\n"))).toHaveLength(2);
  });
});
