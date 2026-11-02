/**
 * Fixture-tree Landofile discovery and validation for lint-guides.
 * `.lando.yml` → full authoring shape; `.lando.*.yml` → fragment (never skip).
 */
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { lintYamlDocument } from "./lint-guides-yaml-fence.ts";
import type { GuideFixtureInventoryEntry, GuideLintDiagnostic } from "./lint-guides.ts";

const FIXTURE_FULL_NAMES = new Set([".lando.yml", ".lando.yaml"]);
const FIXTURE_FRAGMENT_PATTERN = /^\.lando\..+\.ya?ml$/i;
const FIXTURE_SKIP_PATTERN = /^\.lando\.ts$/i;

export type FixtureLandofileForm = "full" | "fragment";

export const classifyFixtureLandofileName = (basename: string): FixtureLandofileForm | "skip" | undefined => {
  if (FIXTURE_SKIP_PATTERN.test(basename)) return "skip";
  if (FIXTURE_FULL_NAMES.has(basename)) return "full";
  if (FIXTURE_FRAGMENT_PATTERN.test(basename)) return "fragment";
  return undefined;
};

const collectLandofileFiles = async (
  absoluteDir: string,
  relativeDir: string,
): Promise<ReadonlyArray<{ readonly relativePath: string; readonly form: FixtureLandofileForm }>> => {
  const found: Array<{ readonly relativePath: string; readonly form: FixtureLandofileForm }> = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { encoding: "utf8", withFileTypes: true });
    for (const entry of entries) {
      const childAbs = resolve(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const form = classifyFixtureLandofileName(entry.name);
      if (form === undefined || form === "skip") continue;
      found.push({ relativePath: childRel, form });
    }
  };
  await walk(absoluteDir, relativeDir);
  return found;
};

/**
 * Validate every `.lando.yml` (full) and `.lando.*.yml` (fragment) under fixture
 * inventory directories. Emits `guide.fixture.landofile-invalid`.
 * Every expect-invalid reason asserts native authoring failure; markers belong on line 1.
 */
export const lintFixtureLandofiles = async (
  repoRoot: string,
  fixtures: ReadonlyArray<GuideFixtureInventoryEntry>,
  diagnostics: Array<GuideLintDiagnostic>,
): Promise<void> => {
  for (const entry of fixtures) {
    if (entry.kind !== "directory") continue;
    const absoluteDir = resolve(repoRoot, entry.sourcePath);
    const files = await collectLandofileFiles(absoluteDir, entry.sourcePath);
    for (const file of files) {
      const absolutePath = resolve(repoRoot, file.relativePath);
      const content = await Bun.file(absolutePath).text();
      const markers = content
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .flatMap((line, index) => {
          const match = /^\s*# lando-lint: expect-invalid\s+(.+)$/.exec(line);
          return match === null ? [] : [{ line: index + 1, reason: match[1]?.trim() }];
        });
      for (const marker of markers) {
        if (marker.line === 1) continue;
        diagnostics.push({
          sourcePath: file.relativePath,
          line: marker.line,
          column: 1,
          code: "guide.fixture.landofile-marker-placement",
          message: "Put the expect-invalid marker on the first line of the fixture.",
        });
      }
      const findings: GuideLintDiagnostic[] = [];
      lintYamlDocument({
        sourcePath: file.relativePath,
        content,
        cwd: dirname(absolutePath),
        // Synthetic fence at line 0 so content line N maps to file line N.
        fence: { type: "code", position: { start: { line: 0, column: 1 } } },
        formOverride: file.form,
        code: "guide.fixture.landofile-invalid",
        parseCode: "guide.fixture.landofile-invalid",
        diagnostics: findings,
      });
      if (markers.length === 0) diagnostics.push(...findings);
      else if (findings.length === 0)
        for (const marker of markers)
          diagnostics.push({
            sourcePath: file.relativePath,
            line: marker.line,
            column: 1,
            code: "guide.fixture.landofile-unexpected-valid",
            message: `Fixture marked expect-invalid decoded successfully: ${marker.reason}. Remove the marker or restore the intended invalid input.`,
          });
    }
  }
};
