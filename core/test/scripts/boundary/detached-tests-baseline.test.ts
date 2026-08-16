import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  collectTestTierViolations,
  readDetachedTestsBaseline,
} from "../../../../scripts/boundary/rules/package-dag-test.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const baselinePath = resolve(repoRoot, "scripts/boundary/detached-tests-baseline.json");
const MAX_TEST_TIER_BASELINE_ENTRIES = 0;
const MAX_PACKAGES_WITHOUT_TESTS = 0;

const edgeKey = (edge: { readonly file: string; readonly specifier: string }): string =>
  `${edge.file}\0${edge.specifier}`;

describe("detached-tests baseline ratchet", () => {
  test("keeps the migration ledger committed", async () => {
    // Given
    const baselineFile = Bun.file(baselinePath);

    // When
    const exists = await baselineFile.exists();

    // Then
    expect(exists).toBe(true);
  });

  test("never grows the test-tier edge ceiling", async () => {
    // Given
    const baseline = await readDetachedTestsBaseline(repoRoot);

    // When
    const entryCount = baseline.testTierEdges.length;

    // Then
    expect(entryCount).toBeLessThanOrEqual(MAX_TEST_TIER_BASELINE_ENTRIES);
  });

  test("never grows the packages-without-tests ceiling", async () => {
    // Given
    const baseline = await readDetachedTestsBaseline(repoRoot);

    // When
    const packageCount = baseline.packagesWithoutTests.length;

    // Then
    expect(packageCount).toBeLessThanOrEqual(MAX_PACKAGES_WITHOUT_TESTS);
  });

  test("contains no stale entries", async () => {
    // Given
    const [baseline, live] = await Promise.all([
      readDetachedTestsBaseline(repoRoot),
      collectTestTierViolations(repoRoot),
    ]);
    const liveEdges = new Set(live.testTierEdges.map(edgeKey));
    const livePackages = new Set(live.packagesWithoutTests.map((entry) => entry.directory));

    // When
    const staleEdges = baseline.testTierEdges.filter((edge) => !liveEdges.has(edgeKey(edge)));
    const stalePackages = baseline.packagesWithoutTests.filter((directory) => !livePackages.has(directory));

    // Then
    expect({ staleEdges, stalePackages }).toEqual({ staleEdges: [], stalePackages: [] });
  });

  test("keeps entries sorted and deduplicated", async () => {
    // Given
    const baseline = await readDetachedTestsBaseline(repoRoot);

    // When
    const edgeKeys = baseline.testTierEdges.map(edgeKey);
    const sortedEdgeKeys = edgeKeys.slice().sort((left, right) => left.localeCompare(right));
    const sortedPackages = baseline.packagesWithoutTests
      .slice()
      .sort((left, right) => left.localeCompare(right));

    // Then
    expect(edgeKeys).toEqual(sortedEdgeKeys);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    expect(baseline.packagesWithoutTests).toEqual(sortedPackages);
    expect(new Set(baseline.packagesWithoutTests).size).toBe(baseline.packagesWithoutTests.length);
  });
});
