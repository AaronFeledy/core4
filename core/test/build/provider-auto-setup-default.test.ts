import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const betaDecisionsPath = resolve(repoRoot, "docs/beta-1-decisions.md");
const tenetsPath = resolve(repoRoot, "spec/01-mission-and-tenets.md");
const guideIndexPath = resolve(repoRoot, "docs/guides/INDEX.md");
const providerAutoSetupGuidePath = resolve(repoRoot, "docs/guides/setup/provider-auto-setup.mdx");

const readText = async (path: string): Promise<string> => Bun.file(path).text();

const sectionBetween = (source: string, startHeading: string, endHeading: string): string => {
  const start = source.indexOf(startHeading);
  expect(start, `expected to find heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  const afterStart = start + startHeading.length;
  const end = source.indexOf(endHeading, afterStart);
  return end === -1 ? source.slice(afterStart) : source.slice(afterStart, end);
};

describe("US-210 provider auto-setup default decision", () => {
  test("publishes a Beta 1 decision note choosing guided opt-in defaults", async () => {
    const betaDecisions = await readText(betaDecisionsPath);

    expect(betaDecisions).toContain("## Provider auto-setup default decision");
    expect(betaDecisions).toMatch(/guided opt-in/i);
    expect(betaDecisions).toMatch(/interactive/i);
    expect(betaDecisions).toMatch(/non-interactive/i);
    expect(betaDecisions).toMatch(/CI/i);
    expect(betaDecisions).toContain("lando setup --yes");
    expect(betaDecisions).toContain("lando setup --provider=lando");
    expect(betaDecisions).not.toMatch(/aggressive auto-setup is the default/i);
  });

  test("moves the provider auto-setup row from §14.2 open decisions into resolved", async () => {
    const tenets = await readText(tenetsPath);

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    expect(openDecisions).not.toContain("How much provider setup is automatic");
    expect(resolved).toContain("Provider auto-setup level");
    expect(resolved).toMatch(/guided opt-in/i);
  });

  test("ships the provider auto-setup guide listed by PRD-02", async () => {
    const [guide, index] = await Promise.all([
      readText(providerAutoSetupGuidePath),
      readText(guideIndexPath),
    ]);

    expect(guide).toContain("id: provider-auto-setup");
    expect(guide).toContain("guided opt-in");
    expect(guide).toContain("lando setup --yes");
    expect(index).toContain(
      "| PRD-02 | US-210 | Provider setup default UX | `docs/guides/setup/provider-auto-setup.mdx` | Shipped |",
    );
  });
});
