import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { COMPOSE_TOP_LEVEL_ACCEPTED_DISPLAY } from "@lando/sdk/schema";

import {
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "../../src/landofile/compose/dispositions.ts";

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

  test("the compatibility guide cross-links the generated matrix instead of enumerating keys", async () => {
    const guide = await readText("docs/guides/config/compose-compatibility.mdx");
    const matrix = await readText("docs/reference/compose-key-matrix.mdx");
    const enumeratingValues = [...guide.matchAll(/<Variable\b[^>]*\bvalue="([^"]*)"/g)]
      .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
      .filter((value) => value.split(",").length >= 3);

    expect(guide).toContain("docs/reference/compose-key-matrix.mdx");
    expect(guide).not.toContain(COMPOSE_TOP_LEVEL_ACCEPTED_DISPLAY);
    expect(enumeratingValues).toEqual([]);

    for (const dispositions of [
      composeTopLevelDispositions,
      composeServiceDispositions,
      composeTagDispositions,
    ]) {
      for (const [key, entry] of Object.entries(dispositions)) {
        expect(matrix).toContain(`| \`${key}\` | ${entry.disposition} |`);
      }
    }
  });

  test("section 14.2 records the Compose subset as resolved by pointing at the generated matrix", async () => {
    const tenets = await readText("spec/01-mission-and-tenets.md");

    const openDecisions = sectionBetween(tenets, "### 14.2 Open decisions", "**Resolved since this draft:**");
    const resolved = sectionBetween(tenets, "**Resolved since this draft:**", "**Deferred to post-v4.0");

    expect(openDecisions).not.toContain("Exact Compose compatibility subset");
    expect(resolved).toContain("Exact Compose compatibility subset");
    expect(resolved).toContain("docs/reference/compose-key-matrix.mdx");
  });

  test("the service-block guide and the generated matrix cross-link in both directions", async () => {
    const guide = await readText("docs/guides/config/compose-service-block.mdx");
    const matrix = await readText("docs/reference/compose-key-matrix.mdx");

    expect(guide).toMatch(/\[[^\]]+\]\(\.\.\/\.\.\/reference\/compose-key-matrix\.mdx\)/);
    // The matrix side is emitted by scripts/build-compose-key-matrix.ts, so this link
    // can only be restored by regenerating the page, never by hand-editing it.
    expect(matrix).toContain("../guides/config/compose-service-block.mdx");
  });
});

/**
 * Detects hand-maintained Compose key lists anywhere in `docs/`.
 *
 * Cheaper heuristics were measured and rejected: flagging any comma-separated
 * `<Variable value>` matched ~40 legitimate pages, and "at least four distinct
 * Compose key names on a line" still matched seven unrelated pages that merely
 * discuss several keys in prose. Only a run of CONSECUTIVE comma-separated items
 * that are each exactly a bare key name distinguishes a maintained classification
 * list from prose or an example snippet, so keep the contiguous-run shape and the
 * fenced-code blanking rather than simplifying either away.
 */
const COMPOSE_KEY_RUN_THRESHOLD = 4;

const LANDO_SIDE_SPELLINGS = [
  "workingDirectory",
  "dependsOn",
  "healthcheck",
  "hostnames",
  "appMount",
  "mounts",
  "storage",
  "endpoints",
  "routes",
  "providers",
  "profiles",
] as const;

const composeKeyVocabulary = (): ReadonlySet<string> => {
  const keys = new Set<string>(LANDO_SIDE_SPELLINGS);
  for (const source of [composeTopLevelDispositions, composeServiceDispositions]) {
    for (const path of Object.keys(source)) {
      const [root = ""] = path.split(".");
      if (root === "" || root === "x-*" || root.startsWith("!")) continue;
      keys.add(root.replace(/\[\]$/, ""));
    }
  }
  return keys;
};

const blankFencedCode = (source: string): string =>
  source.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));

const normalizeItem = (raw: string): string =>
  raw
    .trim()
    .replace(/^(and|or)\s+/i, "")
    .replace(/[`'"*]/g, "")
    .replace(/[.;:]$/, "")
    .trim();

const longestKeyRun = (line: string, keys: ReadonlySet<string>): number => {
  let longest = 0;
  let current = 0;
  for (const raw of line.split(",")) {
    const item = normalizeItem(raw);
    current = keys.has(item) || item === "x-*" ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
};

describe("Compose docs key-list sweep", () => {
  test("no doc outside the generated matrix hand-maintains a Compose key list", async () => {
    const keys = composeKeyVocabulary();
    const violations: Array<string> = [];

    for (const relativePath of new Bun.Glob("docs/**/*.{md,mdx}").scanSync(repoRoot)) {
      const normalized = relativePath.split("\\").join("/");
      if (normalized === "docs/reference/compose-key-matrix.mdx") continue;
      const lines = blankFencedCode(await readText(normalized)).split("\n");
      lines.forEach((line, index) => {
        const run = longestKeyRun(line, keys);
        if (run >= COMPOSE_KEY_RUN_THRESHOLD) {
          violations.push(`${normalized}:${index + 1} enumerates ${run} consecutive Compose keys`);
        }
      });
    }

    expect(violations.sort()).toEqual([]);
  });
});
