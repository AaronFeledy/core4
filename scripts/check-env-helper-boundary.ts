import * as fs from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

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

const hasBlockedNamedImport = (importClause: ts.ImportClause | undefined): boolean => {
  const namedBindings = importClause?.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return false;

  return namedBindings.elements.some((element) => {
    const importedName = element.propertyName?.text ?? element.name.text;
    return BLOCKED_NAMED_IMPORTS.has(importedName);
  });
};

const scanFile = async (root: string, file: string): Promise<ReadonlyArray<EnvHelperBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: EnvHelperBoundaryOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (importsEnvFeatureModule(root, file, specifier) || hasBlockedNamedImport(node.importClause)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({ file, line: line + 1, specifier });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
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
