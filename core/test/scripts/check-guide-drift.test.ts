import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type GuideDriftDeclaration,
  checkGuideDrift,
  checkGuideDriftOnDisk,
  formatDriftDiagnostic,
  formatGuideDriftSummary,
  parseGuideCoverageSurfacePaths,
} from "../../../scripts/check-guide-drift.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

const scaffold = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-drift-"));
  for (const [rel, content] of Object.entries(files)) {
    const absolute = resolve(root, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
};

const prdSection = (
  guides: ReadonlyArray<{ story: string; path: string }>,
  surfaces: ReadonlyArray<string>,
): string => `# Some PRD

## User Stories

Body text mentioning \`core/src/elsewhere.ts\` that must be ignored.

## Guide Coverage

Per PRD-12 US-198/US-199, this PRD owns the executable guides listed below.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
${guides.map((g) => `| ${g.story} | Feature | \`${g.path}\` | Required at story acceptance |`).join("\n")}

**CLI / source surface paths covered (drift gate input):**

${surfaces.map((s) => `- \`${s}\``).join("\n")}

## Open Questions

Nothing here.
`;

const codesFor = (diagnostics: ReadonlyArray<{ code: string }>): ReadonlyArray<string> =>
  diagnostics.map((d) => d.code);

describe("parseGuideCoverageSurfacePaths", () => {
  test("extracts only the drift-gate surface bullets, not guide paths or prose", () => {
    const surfaces = parseGuideCoverageSurfacePaths(
      prdSection(
        [{ story: "US-129", path: "docs/guides/recipes/remote-sources.mdx" }],
        ["core/src/recipes/**", "sdk/src/recipes/**", "plugins/recipe-*/src/**"],
      ),
    );
    expect(surfaces).toEqual(["core/src/recipes/**", "sdk/src/recipes/**", "plugins/recipe-*/src/**"]);
  });

  test("returns nothing when the section declares no surface bullets", () => {
    const surfaces = parseGuideCoverageSurfacePaths(
      "## Guide Coverage\n\n**None — internal/infra PRD.** No executable guides are required.\n\n## Next\n",
    );
    expect(surfaces).toEqual([]);
  });

  test("returns nothing when there is no Guide Coverage section", () => {
    const surfaces = parseGuideCoverageSurfacePaths("# Title\n\n## User Stories\n\nNo coverage.\n");
    expect(surfaces).toEqual([]);
  });
});

const recipeDecl: GuideDriftDeclaration = {
  source: "prd/alpha-3/prd-alpha-3-07-recipes-full-breadth.md",
  surfacePaths: ["core/src/recipes/**", "sdk/src/recipes/**", "plugins/recipe-*/src/**"],
  guidePaths: ["docs/guides/recipes/remote-sources.mdx"],
};

describe("checkGuideDrift (pure)", () => {
  test("S1: touching a covered surface without its guide fails", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/recipes/git-source.ts"],
      prBody: "Implements the git recipe source.",
    });
    expect(result.skip).toBeUndefined();
    expect(codesFor(result.diagnostics)).toContain("drift.guide-not-touched");
    expect(result.diagnostics.some((d) => d.message.includes("prd-alpha-3-07-recipes-full-breadth.md"))).toBe(
      true,
    );
    expect(result.diagnostics.some((d) => d.message.includes("Guide-Coverage-Skip"))).toBe(true);
  });

  test("S1: a wildcard plugin surface match still requires the guide", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["plugins/recipe-acme/src/index.ts"],
      prBody: "Adds a recipe plugin.",
    });
    expect(codesFor(result.diagnostics)).toContain("drift.guide-not-touched");
  });

  test("S2: touching both the surface and one of its guides passes", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/recipes/git-source.ts", "docs/guides/recipes/remote-sources.mdx"],
      prBody: "Implements the git recipe source and updates the guide.",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.skip).toBeUndefined();
  });

  test("S3: a guide-only PR passes (no covered surface touched)", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["docs/guides/recipes/remote-sources.mdx"],
      prBody: "Doc-only tweak.",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("a PR touching neither surface nor guide passes", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/cli/run.ts", "README.md"],
      prBody: "Unrelated change.",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("S4: a Guide-Coverage-Skip tag with a >=24 char reason bypasses the gate", () => {
    const reason = "intentional refactor with no guide-visible behavior change";
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/recipes/git-source.ts"],
      prBody: `Refactor.\n\nGuide-Coverage-Skip: ${reason}\n`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.skip?.reason).toBe(reason);
  });

  test("S5: a Guide-Coverage-Skip tag with a too-short reason fails", () => {
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/recipes/git-source.ts"],
      prBody: "Guide-Coverage-Skip: too short\n",
    });
    expect(codesFor(result.diagnostics)).toContain("drift.skip-reason-too-short");
    expect(result.skip).toBeUndefined();
  });

  test("a skip reason of exactly 24 characters passes", () => {
    const reason = "x".repeat(24);
    const result = checkGuideDrift({
      declarations: [recipeDecl],
      changedFiles: ["core/src/recipes/git-source.ts"],
      prBody: `Guide-Coverage-Skip: ${reason}`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.skip?.reason).toBe(reason);
  });

  test("an empty changed-file set passes (no PR context)", () => {
    const result = checkGuideDrift({ declarations: [recipeDecl], changedFiles: [], prBody: "" });
    expect(result.diagnostics).toEqual([]);
  });

  test("diagnostics format as code: message", () => {
    const formatted = formatDriftDiagnostic({ code: "drift.guide-not-touched", message: "hello" });
    expect(formatted).toBe("drift.guide-not-touched: hello");
  });

  test("formats a PR check summary that includes a valid skip reason", () => {
    const reason = "intentional refactor with no guide-visible behavior change";
    const summary = formatGuideDriftSummary(
      { diagnostics: [], skip: { reason } },
      { changedFiles: ["core/src/recipes/git-source.ts"], prBody: `Guide-Coverage-Skip: ${reason}` },
    );
    expect(summary).toContain("Status: bypassed via `Guide-Coverage-Skip`.");
    expect(summary).toContain(`Reason: ${reason}`);
    expect(summary).toContain("- `core/src/recipes/git-source.ts`");
  });
});

describe("checkGuideDriftOnDisk", () => {
  test("reads real PRD declarations: recipe surface without guide fails", async () => {
    const result = await checkGuideDriftOnDisk(repoRoot, {
      changedFiles: ["core/src/recipes/git-source.ts"],
      prBody: "Implements the git recipe source.",
    });
    expect(codesFor(result.diagnostics)).toContain("drift.guide-not-touched");
    expect(result.diagnostics.some((d) => d.message.includes("prd-alpha-3-07-recipes-full-breadth.md"))).toBe(
      true,
    );
  });

  test("reads real PRD declarations: recipe surface + its guide passes", async () => {
    const result = await checkGuideDriftOnDisk(repoRoot, {
      changedFiles: ["core/src/recipes/git-source.ts", "docs/guides/recipes/remote-sources.mdx"],
      prBody: "Implements the git recipe source and updates the guide.",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("reads alpha-4 PRD declarations: App-handle surface without embedding guide fails", async () => {
    const result = await checkGuideDriftOnDisk(repoRoot, {
      changedFiles: ["core/src/app/handle.ts"],
      prBody: "Adjusts App handle lifecycle behavior.",
    });
    expect(codesFor(result.diagnostics)).toContain("drift.guide-not-touched");
    expect(
      result.diagnostics.some((d) => d.message.includes("prd-alpha-4-11-library-and-acceptance.md")),
    ).toBe(true);
    expect(
      result.diagnostics.some((d) => d.message.includes("docs/guides/library/embedding-runtime.mdx")),
    ).toBe(true);
  });

  test("reads alpha-4 PRD declarations: App-handle surface + embedding guide passes", async () => {
    const result = await checkGuideDriftOnDisk(repoRoot, {
      changedFiles: ["core/src/app/handle.ts", "docs/guides/library/embedding-runtime.mdx"],
      prBody: "Adjusts App handle lifecycle behavior and updates the guide.",
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("an empty changed-file set passes against the real repo", async () => {
    const result = await checkGuideDriftOnDisk(repoRoot, { changedFiles: [], prBody: "" });
    expect(result.diagnostics).toEqual([]);
  });

  test("scaffolded PRD: touch-surface-without-guide fails, touch-both passes", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-07-recipes.md": prdSection(
        [{ story: "US-129", path: "docs/guides/recipes/remote-sources.mdx" }],
        ["core/src/recipes/**"],
      ),
    });
    try {
      const fail = await checkGuideDriftOnDisk(root, {
        changedFiles: ["core/src/recipes/x.ts"],
        prBody: "no guide",
      });
      expect(codesFor(fail.diagnostics)).toContain("drift.guide-not-touched");

      const pass = await checkGuideDriftOnDisk(root, {
        changedFiles: ["core/src/recipes/x.ts", "docs/guides/recipes/remote-sources.mdx"],
        prBody: "touched both",
      });
      expect(pass.diagnostics).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("scaffolded PRD: a valid skip tag bypasses the gate on disk", async () => {
    const root = await scaffold({
      "prd/alpha-3/prd-alpha-3-07-recipes.md": prdSection(
        [{ story: "US-129", path: "docs/guides/recipes/remote-sources.mdx" }],
        ["core/src/recipes/**"],
      ),
    });
    try {
      const reason = "deliberate internal refactor, no user-facing surface change";
      const result = await checkGuideDriftOnDisk(root, {
        changedFiles: ["core/src/recipes/x.ts"],
        prBody: `Body\n\nGuide-Coverage-Skip: ${reason}`,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.skip?.reason).toBe(reason);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
