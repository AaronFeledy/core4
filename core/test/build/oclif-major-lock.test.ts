import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corePackagePath = resolve(repoRoot, "core/package.json");
const betaDecisionsPath = resolve(repoRoot, "docs/beta-1-decisions.md");
const tenetsPath = resolve(repoRoot, "spec/01-mission-and-tenets.md");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const sectionBetween = (source: string, startHeading: string, endHeading: string): string => {
  const start = source.indexOf(startHeading);
  expect(start, `expected to find heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  const afterStart = start + startHeading.length;
  const end = source.indexOf(endHeading, afterStart);
  return end === -1 ? source.slice(afterStart) : source.slice(afterStart, end);
};

describe("US-209 OCLIF major lock decision", () => {
  test("pins the OCLIF v4 dependency ranges cited by the decision note", async () => {
    const corePackage = JSON.parse(await readText(corePackagePath)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(corePackage.dependencies?.["@oclif/core"]).toBe("^4.11.2");
    expect(corePackage.devDependencies?.oclif).toBe("^4.23.0");
  });

  test("publishes a Beta 1 decision note that locks OCLIF on v4 with the cited state", async () => {
    const betaDecisions = await readText(betaDecisionsPath);

    expect(betaDecisions).toContain("## OCLIF major lock decision");
    // Cites the current dependency ranges.
    expect(betaDecisions).toContain("@oclif/core");
    expect(betaDecisions).toContain("^4.11.2");
    expect(betaDecisions).toContain("^4.23.0");
    // Records the choice to stay on v4.
    expect(betaDecisions).toMatch(/stay on OCLIF v4/i);
    expect(betaDecisions).not.toMatch(/move to OCLIF v5/i);
    // Preserves the permanent dual-dispatch parity assumption.
    expect(betaDecisions).toMatch(/dual[- ]dispatch/i);
    expect(betaDecisions).toMatch(/parity/i);
  });

  test("moves the OCLIF major-version row from §14.2 open decisions into resolved", async () => {
    const tenets = await readText(tenetsPath);

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    // No longer an open question.
    expect(openDecisions).not.toContain("OCLIF major version");
    // Now recorded as resolved, staying on v4.
    expect(resolved).toContain("OCLIF major version");
    expect(resolved).toMatch(/v4/);
  });
});
