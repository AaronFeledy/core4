#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { appendFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { extractGuideCoverageSection, parseGuideCoveragePaths } from "./check-guide-coverage.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const SURFACE_HEADER_PATTERN = /surface paths covered/i;
const SURFACE_BULLET_PATTERN = /^\s*-\s+`([^`]+)`/;
const SKIP_TAG_PATTERN = /^Guide-Coverage-Skip:[ \t]*(.*)$/m;

/** Minimum length (after trimming) of a Guide-Coverage-Skip reason. */
export const MIN_SKIP_REASON_LENGTH = 24;

export interface GuideDriftDeclaration {
  /** Planning document path the declaration came from (used in remediation messages). */
  readonly source: string;
  /** Glob patterns describing the CLI/source surface covered by this guide declaration. */
  readonly surfacePaths: ReadonlyArray<string>;
  /** Guide files owned by this declaration (repo-relative `docs/guides/**.mdx` paths). */
  readonly guidePaths: ReadonlyArray<string>;
}

export interface DriftDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface DriftResult {
  readonly diagnostics: ReadonlyArray<DriftDiagnostic>;
  /** Present only when a valid `Guide-Coverage-Skip:` tag bypassed the gate. */
  readonly skip?: { readonly reason: string };
}

export interface CheckGuideDriftInput {
  readonly declarations: ReadonlyArray<GuideDriftDeclaration>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly prBody: string;
}

export interface CheckGuideDriftOptions {
  readonly specDir?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly prBody?: string;
}

const uniqueInOrder = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

export const parseGuideCoverageSurfacePaths = (content: string): ReadonlyArray<string> => {
  const section = extractGuideCoverageSection(content);
  if (section === undefined) return [];
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => SURFACE_HEADER_PATTERN.test(line));
  if (headerIndex === -1) return [];

  const paths: Array<string> = [];
  let started = false;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const bullet = line.match(SURFACE_BULLET_PATTERN);
    if (bullet?.[1] !== undefined) {
      paths.push(bullet[1]);
      started = true;
      continue;
    }
    if (line.trim() === "") {
      if (started) break;
      continue;
    }
    break;
  }
  return uniqueInOrder(paths);
};

const matchesSurface = (pattern: string, file: string): boolean => {
  try {
    return new Bun.Glob(pattern).match(file);
  } catch {
    return false;
  }
};

const formatPathList = (paths: ReadonlyArray<string>): string => paths.map((path) => `"${path}"`).join(", ");

export const checkGuideDrift = (input: CheckGuideDriftInput): DriftResult => {
  const skipMatch = input.prBody.match(SKIP_TAG_PATTERN);
  if (skipMatch) {
    const reason = (skipMatch[1] ?? "").trim();
    if (reason.length >= MIN_SKIP_REASON_LENGTH) {
      return { diagnostics: [], skip: { reason } };
    }
    return {
      diagnostics: [
        {
          code: "drift.skip-reason-too-short",
          message: `PR body declares "Guide-Coverage-Skip:" with a ${reason.length}-character reason, but the guide-drift gate requires at least ${MIN_SKIP_REASON_LENGTH} characters explaining why no guide change is needed.`,
        },
      ],
    };
  }

  const changed = new Set(input.changedFiles);
  const diagnostics: Array<DriftDiagnostic> = [];
  for (const declaration of input.declarations) {
    const touchedSurfaces = input.changedFiles.filter((file) =>
      declaration.surfacePaths.some((pattern) => matchesSurface(pattern, file)),
    );
    if (touchedSurfaces.length === 0) continue;
    if (declaration.guidePaths.some((guide) => changed.has(guide))) continue;
    diagnostics.push({
      code: "drift.guide-not-touched",
      message: `This PR changes ${formatPathList(uniqueInOrder(touchedSurfaces))}, a CLI/source surface declared in ${declaration.source}'s "## Guide Coverage" section, without touching any of its owned guides (${formatPathList(declaration.guidePaths)}). Update one of those guides, or add a PR body line "Guide-Coverage-Skip: <reason ≥ ${MIN_SKIP_REASON_LENGTH} chars>" explaining why no guide change is needed.`,
    });
  }

  diagnostics.sort((left, right) =>
    left.code === right.code
      ? left.message.localeCompare(right.message)
      : left.code.localeCompare(right.code),
  );
  return { diagnostics };
};

export const checkGuideDriftOnDisk = async (
  root = REPO_ROOT,
  options: CheckGuideDriftOptions = {},
): Promise<DriftResult> => {
  const defaultSpecDirs = ["prd/alpha-3", [["s", "pec"].join(""), "alpha-3"].join("/")];
  const defaultSpecFiles = ["spec/alpha-4/prd-alpha-4-11-library-and-acceptance.md"];
  const specDirs =
    options.specDir !== undefined
      ? [options.specDir]
      : uniqueInOrder(defaultSpecDirs).filter((specDir) => existsSync(resolve(root, specDir)));
  const specFiles =
    options.specDir !== undefined
      ? []
      : uniqueInOrder(defaultSpecFiles).filter((specFile) => existsSync(resolve(root, specFile)));

  const declarations: Array<GuideDriftDeclaration> = [];
  const pushDeclaration = async (source: string, absolutePath: string): Promise<void> => {
    const content = await Bun.file(absolutePath).text();
    const surfacePaths = parseGuideCoverageSurfacePaths(content);
    if (surfacePaths.length === 0) return;
    declarations.push({
      source,
      surfacePaths,
      guidePaths: parseGuideCoveragePaths(content),
    });
  };
  for (const specDir of specDirs) {
    let specEntries: ReadonlyArray<string> = [];
    try {
      specEntries = (await readdir(resolve(root, specDir))).filter((name) => name.endsWith(".md")).sort();
    } catch {
      specEntries = [];
    }
    for (const name of specEntries) {
      await pushDeclaration(`${specDir}/${name}`, resolve(root, specDir, name));
    }
  }
  for (const specFile of specFiles) {
    await pushDeclaration(specFile, resolve(root, specFile));
  }

  return checkGuideDrift({
    declarations,
    changedFiles: options.changedFiles ?? [],
    prBody: options.prBody ?? "",
  });
};

export const formatDriftDiagnostic = (diagnostic: DriftDiagnostic): string =>
  `${diagnostic.code}: ${diagnostic.message}`;

const formatSummaryFileList = (files: ReadonlyArray<string>): string =>
  files.length === 0 ? "_No changed files detected._" : files.map((file) => `- \`${file}\``).join("\n");

export const formatGuideDriftSummary = (result: DriftResult, context: DriftContext): string => {
  const header = "## Guide Drift";
  const changedFiles = `### Changed Files\n${formatSummaryFileList(context.changedFiles)}`;
  if (result.skip !== undefined) {
    return `${header}\n\nStatus: bypassed via \`Guide-Coverage-Skip\`.\n\nReason: ${result.skip.reason}\n\n${changedFiles}\n`;
  }
  if (result.diagnostics.length === 0) {
    return `${header}\n\nStatus: passed. Every touched CLI/source surface has a matching guide change.\n\n${changedFiles}\n`;
  }
  const diagnostics = result.diagnostics
    .map((diagnostic) => `- ${formatDriftDiagnostic(diagnostic)}`)
    .join("\n");
  return `${header}\n\nStatus: failed.\n\n### Diagnostics\n${diagnostics}\n\n${changedFiles}\n`;
};

const splitFileList = (value: string): ReadonlyArray<string> =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const gitChangedFiles = (args: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const result = Bun.spawnSync({
    cmd: ["git", "diff", "--name-only", ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) return undefined;
  return splitFileList(result.stdout.toString());
};

interface DriftContext {
  readonly changedFiles: ReadonlyArray<string>;
  readonly prBody: string;
}

/** Resolves the PR's changed files + body from the environment / git, or undefined when there is no PR context. */
export const resolveDriftContext = (env: NodeJS.ProcessEnv = process.env): DriftContext | undefined => {
  const prBody = env.GUIDE_DRIFT_PR_BODY ?? "";

  const explicit = env.GUIDE_DRIFT_CHANGED_FILES;
  if (explicit !== undefined) return { changedFiles: splitFileList(explicit), prBody };

  const baseSha = env.GUIDE_DRIFT_BASE_SHA;
  const headSha = env.GUIDE_DRIFT_HEAD_SHA;
  if (baseSha && headSha) {
    const files = gitChangedFiles([baseSha, headSha]);
    if (files !== undefined) return { changedFiles: files, prBody };
  }

  const baseRef = env.GUIDE_DRIFT_BASE_REF;
  if (baseRef) {
    const files = gitChangedFiles(["--merge-base", baseRef, "HEAD"]);
    if (files !== undefined) return { changedFiles: files, prBody };
  }

  return undefined;
};

const appendStepSummary = async (summary: string, env: NodeJS.ProcessEnv = process.env): Promise<void> => {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.trim() === "") return;
  await appendFile(summaryPath, summary.endsWith("\n") ? summary : `${summary}\n`);
};

const main = async (): Promise<void> => {
  const context = resolveDriftContext();
  if (context === undefined) {
    process.stdout.write(
      "Guide-drift gate skipped: no pull-request context (set GUIDE_DRIFT_* env vars in CI).\n",
    );
    return;
  }

  const result = await checkGuideDriftOnDisk(REPO_ROOT, {
    changedFiles: context.changedFiles,
    prBody: context.prBody,
  });

  await appendStepSummary(formatGuideDriftSummary(result, context));

  if (result.skip !== undefined) {
    process.stdout.write(`Guide-drift gate bypassed via Guide-Coverage-Skip: ${result.skip.reason}\n`);
    return;
  }

  if (result.diagnostics.length === 0) {
    process.stdout.write(
      "Guide-drift gate passed: every touched CLI/source surface has a matching guide change.\n",
    );
    return;
  }

  process.stderr.write(`${result.diagnostics.map(formatDriftDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
