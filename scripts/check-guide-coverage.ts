#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type HomeGuideEntry, loadHomeGuideRegistry } from "./guides/home-guide-registry.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const GUIDE_PATH_PATTERN = /docs\/guides\/[A-Za-z0-9._/-]+\.mdx/;
const VALID_STATUSES = new Set(["Shipped", "Planned"]);
const HOME_GUIDE_PREFIX = "docs/guides/";

export interface GuideCoverageRow {
  readonly prd: string;
  readonly userStory: string;
  readonly feature: string;
  readonly guidePath: string;
  readonly status: string;
}

export interface CoverageDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface CoverageResult {
  readonly diagnostics: ReadonlyArray<CoverageDiagnostic>;
}

/** A line in the guide table that does not carry a usable guide path. */
export interface IndexRowProblem {
  readonly line: number;
  readonly text: string;
}

export interface CheckGuideCoverageInput {
  readonly indexRows: ReadonlyArray<GuideCoverageRow>;
  readonly guideExists: (guidePath: string) => boolean;
  /** Map diagnostics loaded from `scripts/guides/home-guides.ts`. */
  readonly mapDiagnostics: ReadonlyArray<CoverageDiagnostic>;
  /** Guide paths the map names as a home. */
  readonly homeGuides: ReadonlyArray<string>;
  /** Malformed rows of the guide table, which the parser cannot turn into rows. */
  readonly indexProblems?: ReadonlyArray<IndexRowProblem>;
}

export interface CheckGuideCoverageOptions {
  readonly indexPath?: string;
  /** Test seam: an injected map instead of the checked-in HOME_GUIDES. */
  readonly entries?: readonly HomeGuideEntry[];
}

const tableCells = (line: string): ReadonlyArray<string> => {
  const parts = line.trim().split("|");
  if (parts.length > 0 && parts[0]?.trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]?.trim() === "") parts.pop();
  return parts.map((part) => part.trim());
};

const guidePathFrom = (cell: string | undefined): string | undefined => cell?.match(GUIDE_PATH_PATTERN)?.[0];

const isSeparatorCell = (cell: string): boolean => /^:?-{3,}:?$/.test(cell);

/**
 * Parses the feature table and reports its malformed rows. Only a table whose
 * header is the five-column guide table is validated; the recipe README table
 * (`Recipe | Stack | Guide Path | Status`) says its paths are not gated here.
 */
export const parseIndexDocument = (
  content: string,
): { readonly rows: ReadonlyArray<GuideCoverageRow>; readonly problems: ReadonlyArray<IndexRowProblem> } => {
  const rows: Array<GuideCoverageRow> = [];
  const problems: Array<IndexRowProblem> = [];
  let inGuideTable = false;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) {
      inGuideTable = false;
      continue;
    }
    const cells = tableCells(line);
    if (cells.length > 0 && cells.every(isSeparatorCell)) continue;
    if (cells.some((cell) => cell.toLowerCase() === "guide path")) {
      inGuideTable = cells.length === 5 && cells[3]?.toLowerCase() === "guide path";
      continue;
    }
    if (!inGuideTable) continue;
    const guidePath = guidePathFrom(cells[3]);
    if (cells.length < 5 || guidePath === undefined) {
      problems.push({ line: index + 1, text: line.trim() });
      continue;
    }
    rows.push({
      prd: cells[0] ?? "",
      userStory: cells[1] ?? "",
      feature: cells[2] ?? "",
      guidePath,
      status: cells[4] ?? "",
    });
  }
  return { rows, problems };
};

export const parseIndexRows = (content: string): ReadonlyArray<GuideCoverageRow> =>
  parseIndexDocument(content).rows;

export const checkGuideCoverage = (input: CheckGuideCoverageInput): CoverageResult => {
  const diagnostics: Array<CoverageDiagnostic> = [...input.mapDiagnostics];
  const indexPaths = new Set(input.indexRows.map((row) => row.guidePath));

  for (const problem of input.indexProblems ?? []) {
    diagnostics.push({
      code: "coverage.malformed-index-row",
      message: `docs/guides/INDEX.md:${problem.line} is a guide-table row without a \`docs/guides/**.mdx\` path: "${problem.text}". Fix the Guide Path cell or remove the row.`,
    });
  }

  for (const guide of new Set(input.homeGuides)) {
    if (!guide.startsWith(HOME_GUIDE_PREFIX) || indexPaths.has(guide)) continue;
    diagnostics.push({
      code: "coverage.home-guide-missing-index-row",
      message: `${guide} is a home guide in scripts/guides/home-guides.ts, but docs/guides/INDEX.md has no matching row. Add a row, or point the map at the page that is registered.`,
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
  const registry = await loadHomeGuideRegistry(
    root,
    options.entries === undefined ? {} : { entries: options.entries },
  );
  const indexPath = options.indexPath ?? "docs/guides/INDEX.md";

  const indexAbsolute = resolve(root, indexPath);
  if (!existsSync(indexAbsolute)) {
    return {
      diagnostics: [
        ...registry.diagnostics,
        {
          code: "coverage.missing-index",
          message: `${indexPath} does not exist; the feature coverage matrix is required.`,
        },
      ],
    };
  }
  const index = parseIndexDocument(await Bun.file(indexAbsolute).text());

  return checkGuideCoverage({
    indexRows: index.rows,
    indexProblems: index.problems,
    guideExists: (guidePath) => existsSync(resolve(root, guidePath)),
    mapDiagnostics: registry.diagnostics,
    homeGuides: registry.entries.map((entry) => entry.guide),
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
