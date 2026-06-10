import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  COMPOSE_DEPRECATED_TOP_LEVEL_KEYS,
  COMPOSE_EXTENSION_TOP_LEVEL_PATTERN,
  COMPOSE_TOP_LEVEL_KEYS,
} from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const sectionBetween = (source: string, startHeading: string, endHeading: string): string => {
  const start = source.indexOf(startHeading);
  expect(start, `expected to find heading: ${startHeading}`).toBeGreaterThanOrEqual(0);
  const afterStart = start + startHeading.length;
  const end = source.indexOf(endHeading, afterStart);
  return end === -1 ? source.slice(afterStart) : source.slice(afterStart, end);
};

describe("Compose compatibility matrix", () => {
  test("publishes a guide row for the shipped Compose compatibility guide", async () => {
    const index = await readText("docs/guides/INDEX.md");

    expect(index).toContain("US-211");
    expect(index).toContain("docs/guides/config/compose-compatibility.mdx");
    expect(index).toContain(
      "| PRD-02 | US-211 | Compose subset compatibility matrix | `docs/guides/config/compose-compatibility.mdx` | Shipped |",
    );
  });

  test("guide matrix stays aligned with the schema-backed top-level key constants", async () => {
    const guide = await readText("docs/guides/config/compose-compatibility.mdx");
    const accepted = [...COMPOSE_TOP_LEVEL_KEYS, COMPOSE_EXTENSION_TOP_LEVEL_PATTERN].join(", ");

    expect(guide).toContain(`value="${accepted}"`);
    for (const key of COMPOSE_TOP_LEVEL_KEYS) expect(guide).toContain(key);
    for (const key of COMPOSE_DEPRECATED_TOP_LEVEL_KEYS) expect(guide).toContain(`value="${key}"`);
    expect(guide).toContain("profiles");
    expect(guide).toContain("providers.&lt;id&gt;");
  });

  test("moves the Compose subset row from §14.2 open decisions into resolved", async () => {
    const tenets = await readText("spec/01-mission-and-tenets.md");

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    expect(openDecisions).not.toContain("Exact Compose compatibility subset");
    expect(resolved).toContain("Exact Compose compatibility subset");
    for (const key of COMPOSE_TOP_LEVEL_KEYS) expect(resolved).toContain(key);
    expect(resolved).toContain(COMPOSE_EXTENSION_TOP_LEVEL_PATTERN);
  });
});
