import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type ts from "typescript";

export type ImportBoundaryViolation = {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
};

export type CollectImportBoundaryViolationsOptions = {
  readonly packageRoot: string;
  readonly sourceRoot?: string;
  readonly repoRoot?: string;
  readonly packageJson?: {
    readonly name?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  readonly alwaysAllowed?: readonly string[];
};

const DEFAULT_ALWAYS_ALLOWED = ["@lando/sdk", "@lando/container-runtime"] as const;
const FORBIDDEN_CORE_CLI_SEGMENT = `${path.sep}core${path.sep}src${path.sep}cli${path.sep}`;

const isExactOrSubpath = (specifier: string, pkg: string): boolean =>
  specifier === pkg || specifier.startsWith(`${pkg}/`);

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolutePath);
      if (entry.isFile() && absolutePath.endsWith(".ts")) return [absolutePath];
      return [];
    }),
  );
  return files.flat().sort();
};

const moduleSpecifierText = (
  tsModule: typeof ts,
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): string | undefined => {
  if (node.moduleSpecifier !== undefined && tsModule.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  return undefined;
};

const packageNameFromPluginsDir = async (
  pluginsDir: string,
  absolutePath: string,
): Promise<string | undefined> => {
  const relative = path.relative(pluginsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const pluginFolder = relative.split(path.sep)[0];
  if (pluginFolder === undefined || pluginFolder.length === 0) return undefined;
  try {
    const raw = await readFile(path.join(pluginsDir, pluginFolder, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
};

const loadPackageJson = async (
  packageRoot: string,
  override: CollectImportBoundaryViolationsOptions["packageJson"],
): Promise<{ name: string; dependencies: Readonly<Record<string, string>> }> => {
  if (override !== undefined) {
    return {
      name: override.name ?? "fixture-package",
      dependencies: override.dependencies ?? {},
    };
  }
  const raw = await readFile(path.join(packageRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    name?: string;
    dependencies?: Record<string, string>;
  };
  return {
    name: parsed.name ?? path.basename(packageRoot),
    dependencies: parsed.dependencies ?? {},
  };
};

const landoPackageName = (specifier: string): string | undefined => {
  if (!specifier.startsWith("@lando/")) return undefined;
  const parts = specifier.split("/");
  if (parts.length < 2 || parts[1] === undefined || parts[1].length === 0) return undefined;
  return `${parts[0]}/${parts[1]}`;
};

export const collectImportBoundaryViolations = async (
  options: CollectImportBoundaryViolationsOptions,
): Promise<ImportBoundaryViolation[]> => {
  const packageRoot = path.resolve(options.packageRoot);
  const sourceRoot = path.resolve(options.sourceRoot ?? path.join(packageRoot, "src"));
  const repoRoot = path.resolve(options.repoRoot ?? path.join(packageRoot, "..", ".."));
  const alwaysAllowed = new Set(options.alwaysAllowed ?? DEFAULT_ALWAYS_ALLOWED);
  const pkg = await loadPackageJson(packageRoot, options.packageJson);
  const declaredDeps = new Set(Object.keys(pkg.dependencies));
  const pluginsDir = path.join(repoRoot, "plugins");
  const coreRoot = path.join(repoRoot, "core");
  const violations: ImportBoundaryViolation[] = [];
  const tsModule = (await import("typescript")).default;

  const isAllowedLandoPackage = (name: string): boolean => {
    if (name === "@lando/core") return false;
    if (alwaysAllowed.has(name)) return true;
    if (name === pkg.name) return true;
    return declaredDeps.has(name);
  };

  const reasonForSpecifier = async (
    specifier: string,
    containingFile: string,
  ): Promise<string | undefined> => {
    if (isExactOrSubpath(specifier, "@lando/core")) {
      return "plugins must not import @lando/core (any subpath)";
    }
    if (isExactOrSubpath(specifier, "@oclif/core") || specifier.startsWith("@oclif/")) {
      return "plugins must not import OCLIF packages";
    }
    if (specifier.includes("core/src/cli/")) {
      return "plugins must not import core CLI internals";
    }

    const landoPkg = landoPackageName(specifier);
    if (landoPkg !== undefined && !isAllowedLandoPackage(landoPkg)) {
      return `cross-plugin import of ${landoPkg} is not a declared dependency`;
    }

    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(containingFile), specifier);
      if (resolved.startsWith(repoRoot) && resolved.includes(FORBIDDEN_CORE_CLI_SEGMENT)) {
        return "plugins must not import core CLI internals";
      }
      if (resolved === coreRoot || resolved.startsWith(coreRoot + path.sep)) {
        return "plugins must not import @lando/core (any subpath)";
      }
      if (resolved.startsWith(pluginsDir + path.sep)) {
        const targetName = await packageNameFromPluginsDir(pluginsDir, resolved);
        if (targetName !== undefined && !isAllowedLandoPackage(targetName)) {
          return `cross-plugin import of ${targetName} is not a declared dependency`;
        }
      }
    }

    return undefined;
  };

  for (const file of await sourceFiles(sourceRoot)) {
    const content = await readFile(file, "utf8");
    const sourceFile = tsModule.createSourceFile(
      file,
      content,
      tsModule.ScriptTarget.Latest,
      true,
      tsModule.ScriptKind.TS,
    );
    const pending: Array<Promise<void>> = [];
    const visit = (node: ts.Node) => {
      if (tsModule.isImportDeclaration(node) || tsModule.isExportDeclaration(node)) {
        const specifier = moduleSpecifierText(tsModule, node);
        if (specifier !== undefined) {
          pending.push(
            reasonForSpecifier(specifier, file).then((reason) => {
              if (reason !== undefined) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                violations.push({
                  file: path.relative(packageRoot, file),
                  line: line + 1,
                  specifier,
                  reason,
                });
              }
            }),
          );
        }
      }
      tsModule.forEachChild(node, visit);
    };
    tsModule.forEachChild(sourceFile, visit);
    await Promise.all(pending);
  }

  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.specifier.localeCompare(b.specifier),
  );
};
