import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type GuideCoverageRow,
  checkGuideCoverage,
  checkGuideCoverageOnDisk,
  formatCoverageDiagnostic,
  parseGuideCoveragePaths,
  parseIndexRows,
} from "../../../scripts/check-guide-coverage.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

const scaffold = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-coverage-"));
  for (const [rel, content] of Object.entries(files)) {
    const absolute = resolve(root, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
};

const prdSection = (rows: ReadonlyArray<{ story: string; feature: string; path: string }>): string => `
## Guide Coverage

Per PRD-12 US-198, this PRD owns the executable guides listed below.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
${rows.map((r) => `| ${r.story} | ${r.feature} | \`${r.path}\` | Required at story acceptance |`).join("\n")}

## Open Questions
`;

const indexDoc = (rows: ReadonlyArray<GuideCoverageRow>): string => `# Beta Feature Coverage Matrix

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
${rows.map((r) => `| ${r.prd} | ${r.userStory} | ${r.feature} | \`${r.guidePath}\` | ${r.status} |`).join("\n")}
`;

const codesFor = (diagnostics: ReadonlyArray<{ code: string }>): ReadonlyArray<string> =>
  diagnostics.map((d) => d.code);

describe("check:guide-coverage parsers", () => {
  test("parseIndexRows extracts rows and ignores header/separator", () => {
    const rows = parseIndexRows(
      indexDoc([
        {
          prd: "PRD-01",
          userStory: "US-074",
          feature: "Foo",
          guidePath: "docs/guides/setup/foo.mdx",
          status: "Shipped",
        },
        {
          prd: "PRD-06",
          userStory: "US-123",
          feature: "Bar",
          guidePath: "docs/guides/scratch/bar.mdx",
          status: "Planned",
        },
      ]),
    );
    expect(rows).toEqual([
      {
        prd: "PRD-01",
        userStory: "US-074",
        feature: "Foo",
        guidePath: "docs/guides/setup/foo.mdx",
        status: "Shipped",
      },
      {
        prd: "PRD-06",
        userStory: "US-123",
        feature: "Bar",
        guidePath: "docs/guides/scratch/bar.mdx",
        status: "Planned",
      },
    ]);
  });

  test("parseGuideCoveragePaths reads declared paths from the section only", () => {
    const paths = parseGuideCoveragePaths(
      `# Title\n\n## User Stories\n\nignore \`docs/guides/ignored/elsewhere.mdx\`\n${prdSection([
        { story: "US-074", feature: "Foo", path: "docs/guides/setup/foo.mdx" },
        { story: "US-082", feature: "Baz", path: "docs/guides/setup/baz.mdx" },
      ])}`,
    );
    expect(paths).toEqual(["docs/guides/setup/foo.mdx", "docs/guides/setup/baz.mdx"]);
  });

  test("parseGuideCoveragePaths returns nothing for a None declaration", () => {
    const paths = parseGuideCoveragePaths(
      "## Guide Coverage\n\n**None — internal/infra PRD.** No executable guides are required.\n\n## Next\n",
    );
    expect(paths).toEqual([]);
  });
});

describe("check:guide-coverage", () => {
  test("passes on the real repository INDEX and PRD declarations", async () => {
    const result = await checkGuideCoverageOnDisk(repoRoot);
    expect(result.diagnostics.map(formatCoverageDiagnostic)).toEqual([]);
  });

  test("a green INDEX.md (all shipped guides present and on disk) passes", async () => {
    const root = await scaffold({
      "spec/beta/prd-beta-01-providers.md": prdSection([
        { story: "US-074", feature: "Foo", path: "docs/guides/setup/foo.mdx" },
      ]),
      "docs/guides/setup/foo.mdx": "---\nid: foo\n---\n",
      "docs/guides/INDEX.md": indexDoc([
        {
          prd: "PRD-01",
          userStory: "US-074",
          feature: "Foo",
          guidePath: "docs/guides/setup/foo.mdx",
          status: "Shipped",
        },
      ]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a missing guide file behind a Shipped INDEX row fails", async () => {
    const root = await scaffold({
      "spec/beta/prd-beta-01-providers.md": prdSection([
        { story: "US-074", feature: "Foo", path: "docs/guides/setup/foo.mdx" },
      ]),
      "docs/guides/INDEX.md": indexDoc([
        {
          prd: "PRD-01",
          userStory: "US-074",
          feature: "Foo",
          guidePath: "docs/guides/setup/foo.mdx",
          status: "Shipped",
        },
      ]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.missing-guide-file");
      expect(result.diagnostics.some((d) => d.message.includes("docs/guides/setup/foo.mdx"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a PRD-declared guide that exists but is absent from INDEX fails", async () => {
    const root = await scaffold({
      "spec/beta/prd-beta-01-providers.md": prdSection([
        { story: "US-074", feature: "Foo", path: "docs/guides/setup/foo.mdx" },
      ]),
      "docs/guides/setup/foo.mdx": "---\nid: foo\n---\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.missing-index-row");
      expect(result.diagnostics.some((d) => d.message.includes("docs/guides/setup/foo.mdx"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an INDEX row pointing at a non-existent guide fails", async () => {
    const root = await scaffold({
      "spec/beta/prd-beta-01-providers.md": prdSection([]),
      "docs/guides/INDEX.md": indexDoc([
        {
          prd: "PRD-01",
          userStory: "US-074",
          feature: "Ghost",
          guidePath: "docs/guides/setup/ghost.mdx",
          status: "Shipped",
        },
      ]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.missing-guide-file");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a Planned INDEX row whose guide does not exist yet is allowed", async () => {
    const root = await scaffold({
      "spec/beta/prd-beta-06-scratch.md": prdSection([
        { story: "US-123", feature: "Bar", path: "docs/guides/scratch/bar.mdx" },
      ]),
      "docs/guides/INDEX.md": indexDoc([
        {
          prd: "PRD-06",
          userStory: "US-123",
          feature: "Bar",
          guidePath: "docs/guides/scratch/bar.mdx",
          status: "Planned",
        },
      ]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an INDEX row with an unknown Status fails", async () => {
    const result = checkGuideCoverage({
      indexRows: [
        {
          prd: "PRD-01",
          userStory: "US-074",
          feature: "Foo",
          guidePath: "docs/guides/setup/foo.mdx",
          status: "Maybe",
        },
      ],
      declarations: [
        { source: "spec/beta/prd-beta-01-providers.md", guidePath: "docs/guides/setup/foo.mdx" },
      ],
      guideExists: () => true,
    });
    expect(codesFor(result.diagnostics)).toContain("coverage.invalid-status");
  });
});
