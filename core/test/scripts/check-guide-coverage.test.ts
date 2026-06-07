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
  parseGuideCoverageSection,
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

const indexDoc = (rows: ReadonlyArray<GuideCoverageRow>): string => `# Feature Coverage Matrix

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

  test("parseGuideCoverageSection reports a present section with declared paths", () => {
    const section = parseGuideCoverageSection(
      prdSection([
        { story: "US-074", feature: "Foo", path: "docs/guides/setup/foo.mdx" },
        { story: "US-082", feature: "Baz", path: "docs/guides/setup/baz.mdx" },
      ]),
    );
    expect(section).toEqual({
      present: true,
      none: false,
      paths: ["docs/guides/setup/foo.mdx", "docs/guides/setup/baz.mdx"],
    });
  });

  test("parseGuideCoverageSection reports a present None declaration", () => {
    const section = parseGuideCoverageSection(
      "## Guide Coverage\n\n**None — internal/infra PRD.** No executable guides are required.\n\n## Next\n",
    );
    expect(section).toEqual({ present: true, none: true, paths: [] });
  });

  test("parseGuideCoverageSection reports an absent section", () => {
    const section = parseGuideCoverageSection("# Title\n\n## User Stories\n\nNo coverage section here.\n");
    expect(section).toEqual({ present: false, none: false, paths: [] });
  });

  test("parseGuideCoverageSection extracts paths even when prose contains a None substring", () => {
    const section = parseGuideCoverageSection(
      "## Guide Coverage\n\n**None of the legacy flows apply here.**\n\n| Story | Guide |\n| --- | --- |\n| US-074 | docs/guides/setup/foo.mdx |\n\n## Next\n",
    );
    expect(section).toEqual({
      present: true,
      none: false,
      paths: ["docs/guides/setup/foo.mdx"],
    });
  });

  test("parseGuideCoverageSection does not treat a None marker as a declaration when paths are listed", () => {
    const section = parseGuideCoverageSection(
      "## Guide Coverage\n\n**None — but see below.**\n\n| Story | Guide |\n| --- | --- |\n| US-082 | docs/guides/setup/baz.mdx |\n\n## Next\n",
    );
    expect(section.none).toBe(false);
    expect(section.paths).toEqual(["docs/guides/setup/baz.mdx"]);
  });
});

describe("check:guide-coverage", () => {
  test("passes on the real repository INDEX and PRD declarations", async () => {
    const result = await checkGuideCoverageOnDisk(repoRoot);
    expect(result.diagnostics.map(formatCoverageDiagnostic)).toEqual([]);
  });

  test("a green INDEX.md (all shipped guides present and on disk) passes", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-01-providers.md": prdSection([
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
      "prd/alpha-3/prd-alpha-3-01-providers.md": prdSection([
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
      "prd/alpha-3/prd-alpha-3-01-providers.md": prdSection([
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
      "prd/alpha-3/prd-alpha-3-01-providers.md": prdSection([]),
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
      "prd/alpha-3/prd-alpha-3-06-scratch.md": prdSection([
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
        { source: "prd/alpha-3/prd-alpha-3-01-providers.md", guidePath: "docs/guides/setup/foo.mdx" },
      ],
      guideExists: () => true,
    });
    expect(codesFor(result.diagnostics)).toContain("coverage.invalid-status");
  });

  test("a user-facing PRD without a Guide Coverage section fails", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-01-providers.md":
        "# Provider Matrix\n\n## User Stories\n\nNo coverage section.\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.missing-section");
      expect(result.diagnostics.some((d) => d.message.includes("prd-alpha-3-01-providers.md"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an internal PRD that declares None passes the section convention", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-09-renderer.md":
        "# Renderer\n\n## Guide Coverage\n\n**None — internal/infra PRD.** No executable guides are required.\n\n## Open Questions\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a user-facing PRD with a None declaration fails the section convention", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-01-providers.md":
        "# Provider Matrix\n\n## Guide Coverage\n\n**None — internal/infra PRD.** No executable guides are required.\n\n## Open Questions\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.empty-user-facing-section");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a user-facing PRD with an empty Guide Coverage section fails", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-01-providers.md":
        "# Provider Matrix\n\n## Guide Coverage\n\nNo guide rows yet.\n\n## Open Questions\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.empty-user-facing-section");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an internal PRD with guide paths fails the None convention", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-09-renderer.md": prdSection([
        { story: "US-150", feature: "Renderer", path: "docs/guides/rendering/renderer.mdx" },
      ]),
      "docs/guides/INDEX.md": indexDoc([
        {
          prd: "PRD-09",
          userStory: "US-150",
          feature: "Renderer",
          guidePath: "docs/guides/rendering/renderer.mdx",
          status: "Planned",
        },
      ]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.internal-section-not-none");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an internal PRD missing its Guide Coverage section fails", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-13-build.md": "# Build & CI\n\n## User Stories\n\nNo coverage section.\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).toContain("coverage.missing-section");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a user-facing PRD declaring a non-existent guide path fails the gate", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-01-providers.md": prdSection([
        { story: "US-074", feature: "Ghost", path: "docs/guides/setup/ghost.mdx" },
      ]),
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.some((d) => d.message.includes("docs/guides/setup/ghost.mdx"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("the index PRD (PRD-00) and guides PRD (PRD-12) are exempt from the section convention", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-00-index.md": "# Index\n\nNo coverage section.\n",
      "prd/alpha-3/prd-alpha-3-12-guides.md": "# Executable Guides\n\nNo coverage section.\n",
      "docs/guides/INDEX.md": indexDoc([]),
    });
    try {
      const result = await checkGuideCoverageOnDisk(root);
      expect(codesFor(result.diagnostics)).not.toContain("coverage.missing-section");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
