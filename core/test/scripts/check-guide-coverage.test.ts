import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  type GuideCoverageRow,
  checkGuideCoverage,
  checkGuideCoverageOnDisk,
  formatCoverageDiagnostic,
  parseIndexDocument,
  parseIndexRows,
} from "../../../scripts/check-guide-coverage.ts";
import type { HomeGuideEntry } from "../../../scripts/guides/home-guide-registry.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

const guide = (id: string, scenario: boolean): string => `---
id: ${id}
provider: test
---

# ${id}

<Guide>
${scenario ? `  <Scenario id="runs">\n    <Step name="run">\n      <Run command="version" />\n    </Step>\n  </Scenario>\n` : ""}</Guide>
`;

const scaffold = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-coverage-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const absolute = resolve(root, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const child = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error("git init failed");
  return root;
};

const indexDoc = (rows: ReadonlyArray<GuideCoverageRow>): string => `# Feature Coverage Matrix

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
${rows.map((r) => `| ${r.prd} | ${r.userStory} | ${r.feature} | \`${r.guidePath}\` | ${r.status} |`).join("\n")}
`;

const row = (overrides: Partial<GuideCoverageRow> = {}): GuideCoverageRow => ({
  prd: "PRD-06",
  userStory: "US-123",
  feature: "Demo",
  guidePath: "docs/guides/demo.mdx",
  status: "Shipped",
  ...overrides,
});

const entries: readonly HomeGuideEntry[] = [
  { feature: "demo", guide: "docs/guides/demo.mdx", sources: ["src/*.ts"] },
];

const codesFor = (diagnostics: ReadonlyArray<{ code: string }>): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("parseIndexRows extracts rows and ignores header/separator", () => {
  expect(
    parseIndexRows(indexDoc([row(), row({ guidePath: "docs/guides/scratch/bar.mdx", status: "Planned" })])),
  ).toEqual([row(), row({ guidePath: "docs/guides/scratch/bar.mdx", status: "Planned" })]);
});

test("a green INDEX whose home guide is shipped passes", async () => {
  const root = await scaffold({
    "docs/guides/demo.mdx": guide("demo", true),
    "docs/guides/INDEX.md": indexDoc([row()]),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });
  expect(result.diagnostics.map(formatCoverageDiagnostic)).toEqual([]);
});

test("a Shipped row whose guide file is missing fails", async () => {
  const root = await scaffold({
    "docs/guides/demo.mdx": guide("demo", true),
    "docs/guides/INDEX.md": indexDoc([row(), row({ guidePath: "docs/guides/ghost.mdx" })]),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });
  expect(codesFor(result.diagnostics)).toContain("coverage.missing-guide-file");
});

test("a Planned row without a guide file is allowed", async () => {
  const root = await scaffold({
    "docs/guides/demo.mdx": guide("demo", true),
    "docs/guides/INDEX.md": indexDoc([
      row(),
      row({ guidePath: "docs/guides/planned.mdx", status: "Planned" }),
    ]),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });
  expect(result.diagnostics).toEqual([]);
});

test("an unknown status fails", () => {
  const result = checkGuideCoverage({
    indexRows: [row({ status: "Maybe" })],
    guideExists: () => true,
    mapDiagnostics: [],
    homeGuides: [],
  });
  expect(codesFor(result.diagnostics)).toContain("coverage.invalid-status");
});

test("an empty map fails the gate", async () => {
  const root = await scaffold({
    "docs/guides/INDEX.md": indexDoc([row()]),
    "docs/guides/demo.mdx": guide("demo", true),
  });
  const result = await checkGuideCoverageOnDisk(root, { entries: [] });
  expect(codesFor(result.diagnostics)).toContain("registry.empty");
});

test("a home guide with no INDEX row fails", async () => {
  const root = await scaffold({
    "docs/guides/INDEX.md": indexDoc([]),
    "docs/guides/demo.mdx": guide("demo", true),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });
  expect(codesFor(result.diagnostics)).toContain("coverage.home-guide-missing-index-row");
});

test("a home guide with no scenario fails the gate", async () => {
  const root = await scaffold({
    "docs/guides/INDEX.md": indexDoc([row()]),
    "docs/guides/demo.mdx": guide("demo", false),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });
  expect(codesFor(result.diagnostics)).toContain("registry.guide-without-scenario");
});

test("a recipe README home guide needs no INDEX row", async () => {
  const root = await scaffold({
    "docs/guides/INDEX.md": indexDoc([]),
    "recipes/demo/README.mdx": guide("recipe-demo", true),
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, {
    entries: [{ feature: "recipe-demo", guide: "recipes/demo/README.mdx", sources: ["src/*.ts"] }],
  });
  expect(result.diagnostics).toEqual([]);
});

test("the checked-in map passes against the real repository INDEX", async () => {
  const result = await checkGuideCoverageOnDisk(repoRoot);
  expect(result.diagnostics.map(formatCoverageDiagnostic)).toEqual([]);
});

test("parses only the guide table and leaves the recipe table alone", () => {
  const content = `${indexDoc([row()])}
## Recipe stacks

| Recipe | Stack | Guide Path | Status |
|---|---|---|---|
| \`lamp\` | Apache + PHP + MariaDB | \`recipes/lamp/README.mdx\` | Shipped |
`;
  const document = parseIndexDocument(content);
  expect(document.rows).toEqual([row()]);
  expect(document.problems).toEqual([]);
});

test("reports guide-table rows without a usable guide path", async () => {
  const root = await scaffold({
    "docs/guides/demo.mdx": guide("demo", true),
    "docs/guides/INDEX.md": `# Feature Coverage Matrix

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
| PRD-06 | US-123 | Demo | \`docs/guides/demo.mdx\` | Shipped |
| PRD-06 | US-124 | Missing path | not a guide path | Shipped |
| PRD-06 | US-125 | Too few cells |
`,
    "src/covered.ts": "export {};\n",
  });
  const result = await checkGuideCoverageOnDisk(root, { entries });

  const malformed = result.diagnostics.filter(
    (diagnostic) => diagnostic.code === "coverage.malformed-index-row",
  );
  expect(malformed).toHaveLength(2);
  expect(malformed[0]?.message).toContain("docs/guides/INDEX.md:6");
  expect(malformed[0]?.message).toContain("Guide Path");
  expect(malformed[1]?.message).toContain("docs/guides/INDEX.md:7");
});
