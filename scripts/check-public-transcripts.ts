import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildGuideScenarioAst,
  buildPublicTranscript,
  emitPublicTranscripts,
  publicTranscriptRelativePath,
  variantsOf,
} from "./build-guide-scenarios.ts";
import { parseIndexRows } from "./check-guide-coverage.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_INDEX_PATH = "docs/guides/INDEX.md";
const DEFAULT_TRANSCRIPT_ROOT = "dist/transcripts/public/guides";

export interface PublicTranscriptDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface CheckPublicTranscriptsInput {
  readonly expected: ReadonlyArray<string>;
  readonly actual: ReadonlySet<string>;
}

export interface PublicTranscriptCheckResult {
  readonly diagnostics: ReadonlyArray<PublicTranscriptDiagnostic>;
}

export interface CheckPublicTranscriptsOptions {
  readonly bootstrap?: boolean;
  readonly indexPath?: string;
  readonly transcriptRoot?: string;
}

const listJsonFiles = async (root: string, relativeDir: string): Promise<ReadonlyArray<string>> => {
  const results: Array<string> = [];
  const walk = async (relativePath: string): Promise<void> => {
    let entries: ReadonlyArray<Dirent<string>>;
    try {
      entries = await readdir(resolve(root, relativePath), { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (entry.isFile() && child.endsWith(".json")) results.push(child);
    }
  };

  await walk(relativeDir);
  return results;
};

const canBootstrapTranscriptRoot = async (root: string, relativeDir: string): Promise<boolean> => {
  try {
    return (await readdir(resolve(root, relativeDir))).length === 0;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
};

export const checkPublicTranscripts = (input: CheckPublicTranscriptsInput): PublicTranscriptCheckResult => {
  const missing = input.expected
    .filter((path) => !input.actual.has(path))
    .sort((left, right) => left.localeCompare(right));
  return {
    diagnostics: missing.map((path) => ({
      code: "transcript.missing",
      message: `Shipped guide is missing its public transcript artifact: ${path}`,
    })),
  };
};

export const checkPublicTranscriptsOnDisk = async (
  root = REPO_ROOT,
  options: CheckPublicTranscriptsOptions = {},
): Promise<PublicTranscriptCheckResult> => {
  const indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  const transcriptRoot = options.transcriptRoot ?? DEFAULT_TRANSCRIPT_ROOT;
  const indexRows = parseIndexRows(await Bun.file(resolve(root, indexPath)).text());
  const shippedGuidePaths = new Set(
    indexRows.filter((row) => row.status === "Shipped").map((row) => row.guidePath),
  );
  const expected: Array<string> = [];
  const asts = await buildGuideScenarioAst(root);

  for (const guide of asts) {
    if (!shippedGuidePaths.has(guide.sourcePath)) continue;
    for (const scenario of guide.scenarios) {
      for (const variant of variantsOf(guide)) {
        if (buildPublicTranscript(guide, scenario, variant) === undefined) continue;
        expected.push(
          publicTranscriptRelativePath(guide.frontmatter.id, scenario.id, variant, transcriptRoot),
        );
      }
    }
  }

  let actual = new Set(await listJsonFiles(root, transcriptRoot));
  if (
    options.bootstrap === true &&
    expected.length > 0 &&
    (await canBootstrapTranscriptRoot(root, transcriptRoot))
  ) {
    await emitPublicTranscripts(asts, root, transcriptRoot);
    actual = new Set(await listJsonFiles(root, transcriptRoot));
  }
  return checkPublicTranscripts({ expected, actual });
};

export const formatPublicTranscriptDiagnostic = (diagnostic: PublicTranscriptDiagnostic): string =>
  `${diagnostic.code}: ${diagnostic.message}`;

const main = async (): Promise<void> => {
  const result = await checkPublicTranscriptsOnDisk(REPO_ROOT, { bootstrap: true });
  if (result.diagnostics.length === 0) {
    process.stdout.write("All shipped guides have public transcript artifacts.\n");
    return;
  }
  process.stderr.write(`${result.diagnostics.map(formatPublicTranscriptDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
