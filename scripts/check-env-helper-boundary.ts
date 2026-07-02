import * as fs from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { scanModuleEdges } from "./module-edge-scan.ts";

export interface EnvHelperBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface EnvHelperBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<EnvHelperBoundaryOffender>;
}

interface CheckEnvHelperBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SERVICES_ROOT = "plugins/service-lando/src/services";
const ENV_FEATURE_MODULE = "plugins/service-lando/src/features/env.ts";
const BLOCKED_NAMED_IMPORTS = new Set(["landoEnvFeature", "applyEnv"]);

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const resolveImportCandidates = (
  root: string,
  importer: string,
  specifier: string,
): ReadonlyArray<string> => {
  const base = specifier.startsWith(".") ? resolve(dirname(importer), specifier) : resolve(root, specifier);
  return [base, `${base}.ts`, join(base, "index.ts")];
};

const importsEnvFeatureModule = (root: string, importer: string, specifier: string): boolean =>
  resolveImportCandidates(root, importer, specifier).some(
    (candidate) => toRepoRelative(root, candidate) === ENV_FEATURE_MODULE,
  );

const hasBlockedName = (names: ReadonlyArray<string>): boolean =>
  names.some((name) => BLOCKED_NAMED_IMPORTS.has(name));

const scanFile = async (root: string, file: string): Promise<ReadonlyArray<EnvHelperBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const offenders: EnvHelperBoundaryOffender[] = [];

  // Every module edge counts: static imports, statically resolvable dynamic
  // `import()` / `require()` calls, and barrel re-exports. Reaching the env
  // feature module through any of them — or pulling a blocked helper name
  // through an import/re-export from any module — is a boundary violation.
  for (const edge of scanModuleEdges(file, sourceText)) {
    const reachesEnvModule = importsEnvFeatureModule(root, file, edge.specifier);
    const pullsBlockedName =
      (edge.kind === "import" || edge.kind === "re-export") && hasBlockedName(edge.names);
    if (reachesEnvModule || pullsBlockedName) {
      offenders.push({ file, line: edge.line, specifier: edge.specifier });
    }
  }

  return offenders;
};

export const checkEnvHelperBoundary = async (
  options: CheckEnvHelperBoundaryOptions = {},
): Promise<EnvHelperBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (await collectTsFiles(resolve(root, SERVICES_ROOT))).slice().sort();

  const offenders = (await Promise.all(files.map((file) => scanFile(root, file))))
    .flat()
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.specifier.localeCompare(right.specifier),
    );

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: EnvHelperBoundaryOffender): string =>
  `${toRepoRelative(root, offender.file)}:${offender.line}: ${offender.specifier}`;

if (import.meta.main) {
  const result = await checkEnvHelperBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Env helper boundary check passed.\n");
  } else {
    process.stderr.write(
      `Env helper boundary check failed. Service files must not import lando.env helpers directly.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
