import { existsSync } from "node:fs";
import { posix, relative, resolve } from "node:path";

import { type WorkspacePackage, loadWorkspacePackages, resolveWorkspaceSpecifier } from "../graph.ts";
import type { BoundaryRule, FileRecord, ProgramContext } from "../types.ts";

const BASELINE_PATH = "scripts/boundary/detached-tests-baseline.json";
const TEST_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;
const TEST_FILE_SUFFIXES = TEST_MODULE_EXTENSIONS.map((extension) => `.test${extension}`);

export type DetachedTestBaselineEdge = {
  readonly file: string;
  readonly specifier: string;
};

export type DetachedTestsBaseline = {
  readonly note: string;
  readonly testTierEdges: readonly DetachedTestBaselineEdge[];
  readonly packagesWithoutTests: readonly string[];
};

export type TestTierEdgeViolation = DetachedTestBaselineEdge & {
  readonly line: number;
  readonly owner: string;
  readonly target: string;
};

export type TestPresenceViolation = {
  readonly directory: string;
  readonly manifest: string;
};

export type TestTierViolations = {
  readonly testTierEdges: readonly TestTierEdgeViolation[];
  readonly packagesWithoutTests: readonly TestPresenceViolation[];
};

type TestPackage = {
  readonly name: string;
  readonly directory: string;
  readonly directoryPrefix: string;
  readonly testPrefix: string;
  readonly exports: ReadonlyMap<string, string>;
};

const EMPTY_BASELINE: DetachedTestsBaseline = {
  note: "",
  testTierEdges: [],
  packagesWithoutTests: [],
};

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseBaselineEdge = (value: unknown, baselinePath: string): DetachedTestBaselineEdge => {
  if (!isJsonObject(value) || typeof value.file !== "string" || typeof value.specifier !== "string") {
    throw new TypeError(`Invalid detached-tests baseline edge: ${baselinePath}`);
  }
  return { file: value.file, specifier: value.specifier };
};

export const readDetachedTestsBaseline = async (root: string): Promise<DetachedTestsBaseline> => {
  const baselinePath = resolve(root, BASELINE_PATH);
  const baselineFile = Bun.file(baselinePath);
  if (!(await baselineFile.exists())) return EMPTY_BASELINE;
  const parsed: unknown = JSON.parse(await baselineFile.text());
  if (
    !isJsonObject(parsed) ||
    typeof parsed.note !== "string" ||
    !Array.isArray(parsed.testTierEdges) ||
    !Array.isArray(parsed.packagesWithoutTests) ||
    !parsed.packagesWithoutTests.every((value) => typeof value === "string")
  ) {
    throw new TypeError(`Invalid detached-tests baseline: ${baselinePath}`);
  }
  return {
    note: parsed.note,
    testTierEdges: parsed.testTierEdges.map((value) => parseBaselineEdge(value, baselinePath)),
    packagesWithoutTests: parsed.packagesWithoutTests,
  };
};

const testPackages = (
  root: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): readonly TestPackage[] =>
  [...packages.entries()]
    .map(([name, workspacePackage]) => {
      const directory = relative(root, workspacePackage.directory).replaceAll("\\", "/") || ".";
      const directoryPrefix = directory === "." ? "" : `${directory}/`;
      return {
        name,
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

const containsPath = (workspacePackage: TestPackage, path: string): boolean =>
  path === workspacePackage.directory || path.startsWith(workspacePackage.directoryPrefix);

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
        const targetPath = posix.normalize(posix.join(posix.dirname(file.relativePath), normalizedSpecifier));
        if (containsPath(owner, targetPath)) continue;
        const target = owners.find((candidate) => containsPath(candidate, targetPath));
        violations.push({
          file: file.relativePath,
          line: edge.line,
          specifier: edge.specifier,
          owner: owner.name,
          target: target?.name ?? targetPath,
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
  baseline: DetachedTestsBaseline,
): Promise<void> => {
  const baselineEdges = new Set(baseline.testTierEdges.map((edge) => `${edge.file}\0${edge.specifier}`));
  for (const violation of await collectTestEdges(context, packages)) {
    if (baselineEdges.has(`${violation.file}\0${violation.specifier}`)) continue;
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
  baseline: DetachedTestsBaseline,
): void => {
  const baselinePackages = new Set(baseline.packagesWithoutTests);
  for (const violation of collectMissingTests(context, packages)) {
    if (baselinePackages.has(violation.directory)) continue;
    context.report(
      violation.manifest,
      1,
      `[PackageDagMissingTestTree] ${violation.directory} has src/ but no tests. Remediation: add tests under ${violation.directory}/test/.`,
    );
  }
};

export const collectTestTierViolations = async (root: string): Promise<TestTierViolations> => {
  let collected: TestTierViolations | undefined;
  const collectionRule = {
    id: "package-dag-test-collector",
    scope: {
      roots: ["."],
      extensions: [".json", ".ts", ".tsx", ".mts", ".cts"],
      excludeDirNames: [".git", ".local", ".codegraph", "node_modules", "dist"],
    },
    carveOuts: { files: [], prefixes: [] },
    passMessage: "",
    failureHeadline: "",
    onProgram: async (context: ProgramContext): Promise<void> => {
      const packages = await loadWorkspacePackages(context.root);
      collected = {
        testTierEdges: await collectTestEdges(context, packages),
        packagesWithoutTests: collectMissingTests(context, packages),
      };
    },
  } satisfies BoundaryRule;
  const { runRuleSet } = await import("../engine.ts");
  await runRuleSet([collectionRule], root);
  if (collected === undefined) throw new TypeError("Detached-test collection did not run");
  return collected;
};
