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

  test("preserved-key guidance leaves capability behavior to row details and exempts service extensions", async () => {
    // Given / When
    const guide = await readText("docs/guides/config/compose-compatibility.mdx");

    // Then
    expect(guide).toContain("row detail determines whether provider capability checks apply");
    expect(guide).toContain("Service-level `x-*` extensions are inert and are not capability-gated");
    expect(guide).not.toContain("Compose plan extension for provider capability\n  checks");
  });

  test("the service-block guide proves canonical Compose fields through app config", async () => {
    // Given / When
    const guide = await readText("docs/guides/config/compose-service-block.mdx");
    const primary = sectionBetween(
      guide,
      '<Scenario id="paste-compose-service"',
      '<Scenario id="rejected-key-remediation"',
    );
    const applyRemediation = sectionBetween(
      guide,
      '<Step name="apply-remediation">',
      '<Step name="cleanup-remediation">',
    );
    const fixtureIndex = primary.indexOf('<UseFixture name="compose-service-block-demo" />');
    const configVerifyIndex = primary.indexOf('<Verify command="lando app:config --format=json"');
    const startIndex = primary.indexOf('<Run command="lando start" />');

    // Then
    expect(configVerifyIndex).toBeGreaterThan(fixtureIndex);
    expect(configVerifyIndex).toBeLessThan(startIndex);
    expect(primary).toContain('layer="e2e"');
    expect(primary).toContain('tags={["@smoke"]}');
    expect(primary).toContain('<Run command="lando info" />');
    expect(primary).toContain("extra_hosts");
    expect(primary).toContain("published");
    expect(primary).toContain("8080");
    expect(primary).toContain("dependsOn");
    expect(primary).toContain("service_started");
    expect(applyRemediation).not.toContain('<Run command="lando app:config --format=json"');
    expect(applyRemediation).toContain(
      '<Verify command="lando app:config --format=json" expect={{ stdout: { regex: "\\"ok\\":\\\\s*true" } }} />',
    );
    expect(guide).toContain(
      '<Verify errorTag="ComposeKeyRejectedError" expect={{ regex: "Remove container_name and use the Lando service key as the container identity\\\\." }} />',
    );
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
 * Looser heuristics were measured and rejected: any comma-separated `<Variable value>`
 * matched ~40 legitimate pages, and "four distinct Compose keys on one line" still
 * matched seven pages that merely discuss keys in prose. Only a run of CONSECUTIVE
 * comma-separated bare key names separates a maintained classification list from prose
 * or an example, so the contiguous-run shape and the fenced-code blanking both stay.
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
