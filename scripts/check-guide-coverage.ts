#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const GUIDE_PATH_PATTERN = /docs\/guides\/[A-Za-z0-9._/-]+\.mdx/;
const GUIDE_PATH_PATTERN_GLOBAL = /docs\/guides\/[A-Za-z0-9._/-]+\.mdx/g;
const VALID_STATUSES = new Set(["Shipped", "Planned"]);

const PRD_PACKAGE_NUMBER_PATTERN = /prd-([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{2})-/;
const NUMBERED_PACKAGE_PATTERN = /^[a-z]+-\d+$/;
type PackageClassificationRule = {
  readonly userFacing: ReadonlySet<string>;
  readonly internal: ReadonlySet<string>;
};

const NUMBERED_PACKAGE_RULE: PackageClassificationRule = {
  userFacing: new Set(["01", "02", "03", "04", "05", "06", "07", "08", "10", "11"]),
  internal: new Set(["09", "13"]),
};

const NAMED_PACKAGE_RULES: Readonly<Record<string, PackageClassificationRule>> = {
  "service-trust": { userFacing: new Set(["01", "02"]), internal: new Set() },
  "architecture-simplicity": { userFacing: new Set(), internal: new Set(["01", "02", "03", "04"]) },
};

export type PrdClassification = "user-facing" | "internal" | "exempt";

export const classifyPrd = (name: string): PrdClassification => {
  const match = name.match(PRD_PACKAGE_NUMBER_PATTERN);
  const pkg = match?.[1];
  const number = match?.[2];
  if (pkg === undefined || number === undefined) return "exempt";
  const rule =
    NAMED_PACKAGE_RULES[pkg] ?? (NUMBERED_PACKAGE_PATTERN.test(pkg) ? NUMBERED_PACKAGE_RULE : undefined);
  if (rule === undefined) return "exempt";
  if (rule.userFacing.has(number)) return "user-facing";
  if (rule.internal.has(number)) return "internal";
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
  readonly none: boolean;
  readonly pathCount: number;
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
  readonly prdSources?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly indexPath?: string;
}

export interface ResolvedPrdSources {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

const PRD_SOURCES_CONFIG_PATH = "docs/guides/prd-sources.json";

const uniqueInOrder = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const configSources = async (root: string): Promise<ResolvedPrdSources> => {
  const path = resolve(root, PRD_SOURCES_CONFIG_PATH);
  if (!existsSync(path)) return { directories: [], files: [] };
  const value: unknown = await Bun.file(path).json();
  if (!isRecord(value)) return { directories: [], files: [] };
  return { directories: stringArray(value.directories), files: stringArray(value.files) };
};

const existingGenericSources = async (
  root: string,
  sources: ReadonlyArray<string>,
): Promise<ResolvedPrdSources> => {
  const directories: Array<string> = [];
  const files: Array<string> = [];
  for (const source of uniqueInOrder(
    sources.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  )) {
    const absolute = resolve(root, source);
    if (!existsSync(absolute)) continue;
    const sourceStat = await stat(absolute);
    if (sourceStat.isDirectory()) directories.push(source);
    else if (sourceStat.isFile()) files.push(source);
  }
  return { directories, files };
};

export const resolvePrdSources = async (
  root: string,
  options: Pick<CheckGuideCoverageOptions, "prdSources" | "env"> = {},
): Promise<ResolvedPrdSources> => {
  if (options.prdSources !== undefined) return existingGenericSources(root, options.prdSources);
  const envSources = (options.env ?? process.env).LANDO_PRD_SOURCES;
  if (envSources !== undefined) return existingGenericSources(root, envSources.split(delimiter));
  const configured = await configSources(root);
  return {
    directories: configured.directories.filter((source) => existsSync(resolve(root, source))),
    files: configured.files.filter((source) => existsSync(resolve(root, source))),
  };
};

export const parsePrdSourceArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const sources: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--prd-source=")) {
      sources.push(arg.slice("--prd-source=".length));
      continue;
    }
    if (arg === "--prd-source") {
      const value = args[index + 1];
      if (value !== undefined) {
        sources.push(value);
        index += 1;
      }
    }
  }
  return sources;
};

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

export const extractGuideCoverageSection = (content: string): string | undefined => {
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
  const section = extractGuideCoverageSection(content);
  if (section === undefined) return { present: false, none: false, paths: [] };
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const match of section.matchAll(GUIDE_PATH_PATTERN_GLOBAL)) {
    const value = match[0];
    if (seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  const none = paths.length === 0 && /\*\*None\b/i.test(section);
  return { present: true, none, paths };
};

export const parseGuideCoveragePaths = (content: string): ReadonlyArray<string> =>
  parseGuideCoverageSection(content).paths;

export const checkGuideCoverage = (input: CheckGuideCoverageInput): CoverageResult => {
  const diagnostics: Array<CoverageDiagnostic> = [];
  const indexPaths = new Set(input.indexRows.map((row) => row.guidePath));

  for (const prd of input.prdCoverage ?? []) {
    if (prd.classification === "exempt") continue;
    if (!prd.present) {
      diagnostics.push({
        code: "coverage.missing-section",
        message: `${prd.source} is a ${prd.classification} PRD but has no "## Guide Coverage" section; user-facing PRDs must list their guides and internal/infra PRDs must declare None.`,
      });
      continue;
    }
    if (prd.classification === "user-facing" && prd.pathCount === 0) {
      diagnostics.push({
        code: "coverage.empty-user-facing-section",
        message: `${prd.source} is a user-facing PRD but its "## Guide Coverage" section declares no guide paths.`,
      });
    }
    if (prd.classification === "internal" && !prd.none) {
      diagnostics.push({
        code: "coverage.internal-section-not-none",
        message: `${prd.source} is an internal/infra PRD but its "## Guide Coverage" section does not declare None.`,
      });
    }
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
  const prdSources = await resolvePrdSources(root, options);
  const indexPath = options.indexPath ?? "docs/guides/INDEX.md";

  const indexAbsolute = resolve(root, indexPath);
  if (!existsSync(indexAbsolute)) {
    return {
      diagnostics: [
        {
          code: "coverage.missing-index",
          message: `${indexPath} does not exist; the feature coverage matrix is required.`,
        },
      ],
    };
  }
  const indexRows = parseIndexRows(await Bun.file(indexAbsolute).text());

  const declarations: Array<GuideCoverageDeclaration> = [];
  const prdCoverage: Array<PrdGuideCoverage> = [];
  const pushPrd = async (source: string, absolutePath: string): Promise<void> => {
    const content = await Bun.file(absolutePath).text();
    const section = parseGuideCoverageSection(content);
    prdCoverage.push({
      source,
      classification: classifyPrd(source.split("/").at(-1) ?? source),
      present: section.present,
      none: section.none,
      pathCount: section.paths.length,
    });
    for (const guidePath of section.paths) declarations.push({ source, guidePath });
  };
  for (const prdDir of prdSources.directories) {
    let prdEntries: ReadonlyArray<string> = [];
    try {
      prdEntries = (await readdir(resolve(root, prdDir))).filter((name) => name.endsWith(".md")).sort();
    } catch {
      prdEntries = [];
    }
    for (const name of prdEntries) await pushPrd(`${prdDir}/${name}`, resolve(root, prdDir, name));
  }
  for (const prdFile of prdSources.files) await pushPrd(prdFile, resolve(root, prdFile));

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
  const cliSources = parsePrdSourceArgs(process.argv.slice(2));
  const result = await checkGuideCoverageOnDisk(
    REPO_ROOT,
    cliSources.length === 0 ? {} : { prdSources: cliSources },
  );
  if (result.diagnostics.length === 0) {
    process.stdout.write("Guide coverage matrix is consistent.\n");
    return;
  }
  process.stderr.write(`${result.diagnostics.map(formatCoverageDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
