import { relative, resolve } from "node:path";

import { scanModuleEdges } from "./module-edge-scan.ts";

export interface PackageDagViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface PackageDagResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<PackageDagViolation>;
}

interface CheckPackageDagOptions {
  readonly root: string;
}

interface PluginPackage {
  readonly name: string;
  readonly directory: string;
  readonly dependencies: ReadonlySet<string>;
}

interface PluginEdge {
  readonly source: string;
  readonly target: string;
  readonly violation: PackageDagViolation;
}

const PLUGIN_MANIFEST_GLOB = new Bun.Glob("plugins/*/package.json");
const PLUGIN_SOURCE_GLOB = new Bun.Glob("plugins/*/src/**/*.ts");
const CORE_SOURCE_GLOB = new Bun.Glob("core/src/**/*.ts");
const ALWAYS_ALLOWED = ["@lando/sdk", "@lando/container-runtime"] as const;

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toRelative = (root: string, path: string): string => relative(root, path).replaceAll("\\", "/");

const isProductionSource = (path: string): boolean =>
  !path.endsWith(".test.ts") && !path.split("/").includes("test");

const packageMatches = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const readPluginPackage = async (manifest: string): Promise<PluginPackage> => {
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  if (!isJsonObject(parsed) || typeof parsed.name !== "string") {
    throw new TypeError(`Invalid plugin package manifest: ${manifest}`);
  }
  const dependencies = isJsonObject(parsed.dependencies)
    ? new Set(Object.keys(parsed.dependencies))
    : new Set<string>();
  return { name: parsed.name, directory: resolve(manifest, ".."), dependencies };
};

const collectPluginPackages = async (root: string): Promise<ReadonlyArray<PluginPackage>> => {
  const manifests: string[] = [];
  for await (const path of PLUGIN_MANIFEST_GLOB.scan({ cwd: root, onlyFiles: true })) {
    manifests.push(resolve(root, path));
  }
  return Promise.all(manifests.sort().map(readPluginPackage));
};

const collectFiles = async (root: string, glob: Bun.Glob): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    if (isProductionSource(path)) files.push(resolve(root, path));
  }
  return files.sort();
};

const reaches = (start: string, goal: string, graph: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
  const pending = [start];
  const visited = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === goal) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
};

const violationKey = (violation: PackageDagViolation): string =>
  `${violation.file}\0${violation.line}\0${violation.specifier}`;

export const checkPackageDag = async ({
  root: rootInput,
}: CheckPackageDagOptions): Promise<PackageDagResult> => {
  const root = resolve(rootInput);
  const packages = await collectPluginPackages(root);
  const violations = new Map<string, PackageDagViolation>();
  const pluginEdges: PluginEdge[] = [];

  for (const file of await collectFiles(root, PLUGIN_SOURCE_GLOB)) {
    const owner = packages.find((pkg) => file.startsWith(`${pkg.directory}/src/`));
    if (owner === undefined) continue;
    for (const edge of scanModuleEdges(file, await Bun.file(file).text())) {
      const violation = { file: toRelative(root, file), line: edge.line, specifier: edge.specifier };
      if (packageMatches(edge.specifier, "@lando/core")) {
        violations.set(violationKey(violation), violation);
        continue;
      }
      if (ALWAYS_ALLOWED.some((name) => packageMatches(edge.specifier, name))) continue;
      const target = packages.find((pkg) => packageMatches(edge.specifier, pkg.name));
      if (target === undefined || target.name === owner.name) continue;
      pluginEdges.push({ source: owner.name, target: target.name, violation });
      if (!owner.dependencies.has(target.name)) violations.set(violationKey(violation), violation);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const edge of pluginEdges) {
    const targets = graph.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    graph.set(edge.source, targets);
  }
  for (const edge of pluginEdges) {
    if (reaches(edge.target, edge.source, graph)) {
      violations.set(violationKey(edge.violation), edge.violation);
    }
  }

  for (const file of await collectFiles(root, CORE_SOURCE_GLOB)) {
    const relativeFile = toRelative(root, file);
    if (relativeFile.startsWith("core/src/plugins/generated/")) continue;
    for (const edge of scanModuleEdges(file, await Bun.file(file).text())) {
      if (!packages.some((pkg) => packageMatches(edge.specifier, pkg.name))) continue;
      const violation = { file: relativeFile, line: edge.line, specifier: edge.specifier };
      violations.set(violationKey(violation), violation);
    }
  }

  const sorted = [...violations.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.specifier.localeCompare(right.specifier),
  );
  return { ok: sorted.length === 0, violations: sorted };
};

const rootArgument = (args: ReadonlyArray<string>): string | undefined => {
  const index = args.indexOf("--root");
  if (index >= 0) return args[index + 1];
  return args.find((argument) => argument.startsWith("--root="))?.slice("--root=".length);
};

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const root = resolve(rootArgument(process.argv.slice(2)) ?? resolve(import.meta.dirname, ".."));
  const result = await checkPackageDag({ root });
  const details = result.violations.map(
    (violation) => `${violation.file}:${violation.line}: ${violation.specifier}`,
  );
  const output = `${details.length === 0 ? "" : `${details.join("\n")}\n`}Package DAG violations: ${details.length}\n`;
  if (report) {
    process.stdout.write(output);
  } else if (result.ok) {
    process.stdout.write("Package DAG check passed.\n");
  } else {
    process.stderr.write(`Package DAG check failed. Fix package dependency direction:\n${output}`);
    process.exitCode = 1;
  }
}
