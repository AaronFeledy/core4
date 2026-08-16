import { existsSync } from "node:fs";
import { dirname, normalize, relative, resolve, sep } from "node:path";

import { type WorkspacePackage, resolveWorkspaceSpecifier } from "../graph.ts";
import type { FileRecord, ProgramContext } from "../types.ts";

const TEST_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const TEST_FILE_SUFFIXES = TEST_MODULE_EXTENSIONS.map((extension) => `.test${extension}`);

type TestTierEdgeViolation = {
  readonly file: string;
  readonly specifier: string;
  readonly line: number;
  readonly owner: string;
  readonly target: string;
};

type TestPresenceViolation = {
  readonly directory: string;
  readonly manifest: string;
};

type TestPackage = {
  readonly name: string;
  readonly absoluteDirectory: string;
  readonly absoluteDirectoryPrefix: string;
  readonly directory: string;
  readonly directoryPrefix: string;
  readonly testPrefix: string;
  readonly exports: ReadonlyMap<string, string>;
};

const testPackages = (
  root: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): readonly TestPackage[] =>
  [...packages.entries()]
    .map(([name, workspacePackage]) => {
      const absoluteDirectory = normalize(workspacePackage.directory);
      const directory = relative(root, workspacePackage.directory).replaceAll("\\", "/") || ".";
      const directoryPrefix = directory === "." ? "" : `${directory}/`;
      return {
        name,
        absoluteDirectory,
        absoluteDirectoryPrefix: `${absoluteDirectory}${sep}`,
        directory,
        directoryPrefix,
        testPrefix: `${directoryPrefix}test/`,
        exports: workspacePackage.exports,
      };
    })
    .sort((left, right) => right.directory.length - left.directory.length);

const isTestModule = (file: FileRecord, workspacePackage: TestPackage): boolean =>
  file.relativePath.startsWith(workspacePackage.testPrefix) &&
  TEST_MODULE_EXTENSIONS.some((extension) => file.relativePath.endsWith(extension));

const containsResolvedPath = (workspacePackage: TestPackage, path: string): boolean =>
  path === workspacePackage.absoluteDirectory || path.startsWith(workspacePackage.absoluteDirectoryPrefix);

const workspaceTarget = (specifier: string, packages: readonly TestPackage[]): TestPackage | undefined =>
  packages.find(
    (workspacePackage) =>
      specifier === workspacePackage.name || specifier.startsWith(`${workspacePackage.name}/`),
  );

const publicSubpath = (
  specifier: string,
  target: TestPackage,
  packages: ReadonlyMap<string, WorkspacePackage>,
): boolean => {
  const subpath = specifier === target.name ? "." : `.${specifier.slice(target.name.length)}`;
  if (subpath === ".") return true;
  return (
    !subpath.includes("*") &&
    target.exports.has(subpath) &&
    resolveWorkspaceSpecifier(specifier, packages) !== undefined
  );
};

const collectTestEdges = async (
  context: ProgramContext,
  packages: ReadonlyMap<string, WorkspacePackage>,
): Promise<readonly TestTierEdgeViolation[]> => {
  const owners = testPackages(context.root, packages);
  const violations: TestTierEdgeViolation[] = [];
  for (const file of context.files) {
    const owner = owners.find((candidate) => isTestModule(file, candidate));
    if (owner === undefined) continue;
    const sourceText = await context.text(file);
    const mayEscapePackage = sourceText.includes("../") || sourceText.includes("..\\");
    if (!sourceText.includes("@lando/") && !mayEscapePackage) continue;
    for (const edge of await context.edges(file)) {
      const normalizedSpecifier = edge.specifier.replaceAll("\\", "/");
      if (normalizedSpecifier.startsWith(".")) {
        const targetPath = normalize(resolve(dirname(file.absolutePath), normalizedSpecifier));
        const target = owners.find((candidate) => containsResolvedPath(candidate, targetPath));
        if (target === undefined || target.name === owner.name) continue;
        violations.push({
          file: file.relativePath,
          line: edge.line,
          specifier: edge.specifier,
          owner: owner.name,
          target: target.name,
        });
        continue;
      }
      const target = workspaceTarget(edge.specifier, owners);
      if (
        target === undefined ||
        target.name === owner.name ||
        publicSubpath(edge.specifier, target, packages)
      ) {
        continue;
      }
      violations.push({
        file: file.relativePath,
        line: edge.line,
        specifier: edge.specifier,
        owner: owner.name,
        target: target.name,
      });
    }
  }
  return violations;
};

const collectMissingTests = (
  context: ProgramContext,
  packages: ReadonlyMap<string, WorkspacePackage>,
): readonly TestPresenceViolation[] =>
  testPackages(context.root, packages).flatMap((workspacePackage) => {
    if (!existsSync(resolve(context.root, workspacePackage.directory, "src"))) return [];
    const hasTests = context.files.some(
      (file) =>
        file.relativePath.startsWith(workspacePackage.testPrefix) &&
        TEST_FILE_SUFFIXES.some((suffix) => file.relativePath.endsWith(suffix)),
    );
    return hasTests
      ? []
      : [
          {
            directory: workspacePackage.directory,
            manifest: `${workspacePackage.directoryPrefix}package.json`,
          },
        ];
  });

export const checkPackageTestEdges = async (
  context: ProgramContext,
  packages: ReadonlyMap<string, WorkspacePackage>,
): Promise<void> => {
  for (const violation of await collectTestEdges(context, packages)) {
    context.report(
      violation.file,
      violation.line,
      `[PackageDagDetachedTestEdge] ${violation.owner} test -> ${violation.specifier}. Remediation: move this test into ${violation.target}/test, or import ${violation.target} through its root export or a named exports subpath.`,
    );
  }
};

export const checkPackageTestPresence = (
  context: ProgramContext,
  packages: ReadonlyMap<string, WorkspacePackage>,
): void => {
  for (const violation of collectMissingTests(context, packages)) {
    context.report(
      violation.manifest,
      1,
      `[PackageDagMissingTestTree] ${violation.directory} has src/ but no tests. Remediation: add tests under ${violation.directory}/test/.`,
    );
  }
};
