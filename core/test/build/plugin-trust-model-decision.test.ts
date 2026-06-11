import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const sectionBetween = (source: string, startHeading: string, endHeading: string): string => {
  const start = source.indexOf(startHeading);
  expect(start, `expected to find heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  const afterStart = start + startHeading.length;
  const end = source.indexOf(endHeading, afterStart);
  return end === -1 ? source.slice(afterStart) : source.slice(afterStart, end);
};

describe("plugin trust model decision", () => {
  test("publishes list/revoke, non-expiring trust, scope, and flag model", async () => {
    const decisions = await readText("docs/beta-1-decisions.md");

    expect(decisions).toContain("## Plugin trust model decision");
    expect(decisions).toContain("meta:plugin:trust list");
    expect(decisions).toContain("meta:plugin:trust revoke");
    expect(decisions).toMatch(/non-expiring/i);
    expect(decisions).toContain("npm/registry");
    expect(decisions).toContain("git");
    expect(decisions).toContain("local");
    expect(decisions).toContain("--trust");
    expect(decisions).toContain("non-interactive");
  });

  test("moves the plugin trust row from §14.2 open decisions into resolved", async () => {
    const tenets = await readText("spec/01-mission-and-tenets.md");

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    expect(openDecisions).not.toContain("Plugin postinstall trust model");
    expect(resolved).toContain("Plugin postinstall trust model");
    expect(resolved).toContain("non-expiring");
    expect(resolved).toContain("meta:plugin:trust revoke");
  });

  test("publishes the trust-management guide and index row", async () => {
    const guide = await readText("docs/guides/plugins/trust-management.mdx");
    const index = await readText("docs/guides/INDEX.md");

    expect(guide).toContain("plugin:trust list");
    expect(guide).toContain("plugin:trust revoke");
    expect(guide).toContain("non-expiring");
    expect(index).toContain(
      "| PRD-02 | US-214 | Trust list/revoke and scope decision | `docs/guides/plugins/trust-management.mdx` | Shipped |",
    );
  });
});
