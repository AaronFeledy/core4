#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const GUIDE_PATH_PATTERN = /docs\/guides\/[A-Za-z0-9._/-]+\.mdx/;
const GUIDE_PATH_PATTERN_GLOBAL = /docs\/guides\/[A-Za-z0-9._/-]+\.mdx/g;
const VALID_STATUSES = new Set(["Shipped", "Planned"]);

const PRD_NUMBER_PATTERN = /prd-beta-(\d{2})-/;
const USER_FACING_PRD_NUMBERS = new Set(["01", "02", "03", "04", "05", "06", "07", "08", "10", "11"]);
const INTERNAL_PRD_NUMBERS = new Set(["09", "13"]);

export type PrdClassification = "user-facing" | "internal" | "exempt";

export const classifyPrd = (name: string): PrdClassification => {
  const number = name.match(PRD_NUMBER_PATTERN)?.[1];
  if (number === undefined) return "exempt";
  if (USER_FACING_PRD_NUMBERS.has(number)) return "user-facing";
  if (INTERNAL_PRD_NUMBERS.has(number)) return "internal";
  return "exempt";
};

export interface GuideCoverageRow {
  readonly prd: string;
  readonly userStory: string;
  readonly feature: string;
  readonly guidePath: string;
  readonly status: string;
}

export interface GuideCoverageDeclaration {
  readonly source: string;
  readonly guidePath: string;
}

export interface GuideCoverageSection {
  readonly present: boolean;
  readonly none: boolean;
  readonly paths: ReadonlyArray<string>;
}

export interface PrdGuideCoverage {
  readonly source: string;
  readonly classification: PrdClassification;
  readonly present: boolean;
}

export interface CoverageDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface CoverageResult {
  readonly diagnostics: ReadonlyArray<CoverageDiagnostic>;
}

export interface CheckGuideCoverageInput {
  readonly indexRows: ReadonlyArray<GuideCoverageRow>;
  readonly declarations: ReadonlyArray<GuideCoverageDeclaration>;
  readonly guideExists: (guidePath: string) => boolean;
  readonly prdCoverage?: ReadonlyArray<PrdGuideCoverage>;
}

export interface CheckGuideCoverageOptions {
  readonly specDir?: string;
  readonly indexPath?: string;
}

const tableCells = (line: string): ReadonlyArray<string> => {
  const parts = line.trim().split("|");
  if (parts.length > 0 && parts[0]?.trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]?.trim() === "") parts.pop();
  return parts.map((part) => part.trim());
};

const guidePathFrom = (cell: string | undefined): string | undefined => cell?.match(GUIDE_PATH_PATTERN)?.[0];

export const parseIndexRows = (content: string): ReadonlyArray<GuideCoverageRow> => {
  const rows: Array<GuideCoverageRow> = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = tableCells(line);
    if (cells.length < 5) continue;
    const guidePath = guidePathFrom(cells[3]);
    if (guidePath === undefined) continue;
    rows.push({
      prd: cells[0] ?? "",
      userStory: cells[1] ?? "",
      feature: cells[2] ?? "",
      guidePath,
      status: cells[4] ?? "",
    });
  }
  return rows;
};

const guideCoverageSection = (content: string): string | undefined => {
  const lines = content.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+Guide Coverage\b/.test(lines[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  const body: Array<string> = [];
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index] ?? "")) break;
    body.push(lines[index] ?? "");
  }
  return body.join("\n");
};

export const parseGuideCoverageSection = (content: string): GuideCoverageSection => {
  const section = guideCoverageSection(content);
  if (section === undefined) return { present: false, none: false, paths: [] };
  if (/\*\*None\b/i.test(section)) return { present: true, none: true, paths: [] };
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of section.matchAll(GUIDE_PATH_PATTERN_GLOBAL)) {
    const value = match[0];
    if (seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return { present: true, none: false, paths };
};

export const parseGuideCoveragePaths = (content: string): ReadonlyArray<string> =>
  parseGuideCoverageSection(content).paths;

export const checkGuideCoverage = (input: CheckGuideCoverageInput): CoverageResult => {
  const diagnostics: Array<CoverageDiagnostic> = [];
  const indexPaths = new Set(input.indexRows.map((row) => row.guidePath));

  for (const prd of input.prdCoverage ?? []) {
    if (prd.classification === "exempt") continue;
    if (prd.present) continue;
    diagnostics.push({
      code: "coverage.missing-section",
      message: `${prd.source} is a ${prd.classification} PRD but has no "## Guide Coverage" section; user-facing PRDs must list their guides and internal/infra PRDs must declare None.`,
    });
  }

  const seenDeclaration = new Set<string>();
  for (const declaration of input.declarations) {
    if (indexPaths.has(declaration.guidePath)) continue;
    const key = `${declaration.source}:${declaration.guidePath}`;
    if (seenDeclaration.has(key)) continue;
    seenDeclaration.add(key);
    diagnostics.push({
      code: "coverage.missing-index-row",
      message: `${declaration.source} declares "${declaration.guidePath}" in its ## Guide Coverage section, but docs/guides/INDEX.md has no matching row.`,
    });
  }

  for (const row of input.indexRows) {
    if (!VALID_STATUSES.has(row.status)) {
      diagnostics.push({
        code: "coverage.invalid-status",
        message: `docs/guides/INDEX.md row "${row.guidePath}" has Status "${row.status}" (expected Shipped or Planned).`,
      });
    }
    if (row.status !== "Planned" && !input.guideExists(row.guidePath)) {
      diagnostics.push({
        code: "coverage.missing-guide-file",
        message: `docs/guides/INDEX.md row "${row.guidePath}" (Status: ${row.status === "" ? "(none)" : row.status}) does not reference a guide that exists on disk.`,
      });
    }
  }

  diagnostics.sort((left, right) =>
    left.code === right.code
      ? left.message.localeCompare(right.message)
      : left.code.localeCompare(right.code),
  );
  return { diagnostics };
};

export const checkGuideCoverageOnDisk = async (
  root = REPO_ROOT,
  options: CheckGuideCoverageOptions = {},
): Promise<CoverageResult> => {
  const specDir = options.specDir ?? "spec/beta";
  const indexPath = options.indexPath ?? "docs/guides/INDEX.md";

  const indexAbsolute = resolve(root, indexPath);
  if (!existsSync(indexAbsolute)) {
    return {
      diagnostics: [
        {
          code: "coverage.missing-index",
          message: `${indexPath} does not exist; the Beta feature coverage matrix is required.`,
        },
      ],
    };
  }
  const indexRows = parseIndexRows(await Bun.file(indexAbsolute).text());

  const declarations: Array<GuideCoverageDeclaration> = [];
  const prdCoverage: Array<PrdGuideCoverage> = [];
  let specEntries: ReadonlyArray<string> = [];
  try {
    specEntries = (await readdir(resolve(root, specDir))).filter((name) => name.endsWith(".md")).sort();
  } catch {
    specEntries = [];
  }
  for (const name of specEntries) {
    const content = await Bun.file(resolve(root, specDir, name)).text();
    const section = parseGuideCoverageSection(content);
    prdCoverage.push({
      source: `${specDir}/${name}`,
      classification: classifyPrd(name),
      present: section.present,
    });
    for (const guidePath of section.paths) {
      declarations.push({ source: `${specDir}/${name}`, guidePath });
    }
  }

  return checkGuideCoverage({
    indexRows,
    declarations,
    guideExists: (guidePath) => existsSync(resolve(root, guidePath)),
    prdCoverage,
  });
};

export const formatCoverageDiagnostic = (diagnostic: CoverageDiagnostic): string =>
  `${diagnostic.code}: ${diagnostic.message}`;

const main = async (): Promise<void> => {
  const result = await checkGuideCoverageOnDisk(REPO_ROOT);
  if (result.diagnostics.length === 0) {
    process.stdout.write("Guide coverage matrix is consistent.\n");
    return;
  }
  process.stderr.write(`${result.diagnostics.map(formatCoverageDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
