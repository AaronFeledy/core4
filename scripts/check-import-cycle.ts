import { dirname, extname, join, relative, resolve } from "node:path";

import { scanModuleEdges } from "./module-edge-scan.ts";

export interface ImportCycleEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly specifier: string;
}

export interface ImportCycle {
  readonly modules: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<ImportCycleEdge>;
}

export interface ImportCycleResult {
  readonly ok: boolean;
  readonly filesScanned: number;
  readonly cycles: ReadonlyArray<ImportCycle>;
}

interface CheckImportCycleOptions {
  readonly root: string;
}

interface WorkspacePackage {
  readonly directory: string;
  readonly exports: ReadonlyMap<string, string>;
}

interface RuntimeEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly specifier: string;
}

interface JsonObject {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly exports?: unknown;
  readonly import?: unknown;
  readonly types?: unknown;
  readonly [key: string]: unknown;
}

const PACKAGE_SOURCE_GLOB = new Bun.Glob("{core,sdk,container-runtime}/src/**/*.{ts,tsx,mts,cts}");
const PLUGIN_SOURCE_GLOB = new Bun.Glob("plugins/*/src/**/*.{ts,tsx,mts,cts}");
const PLUGIN_MANIFEST_GLOB = new Bun.Glob("plugins/*/package.json");
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts)$/;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runtimeTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!isJsonObject(value)) return undefined;
  const importTarget = value.import;
  if (typeof importTarget === "string") return importTarget;
  const typesTarget = value.types;
  return typeof typesTarget === "string" ? typesTarget : undefined;
};

const readWorkspacePackage = async (manifest: string): Promise<readonly [string, WorkspacePackage]> => {
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  if (!isJsonObject(parsed) || typeof parsed.name !== "string") {
    throw new TypeError(`Invalid workspace package manifest: ${manifest}`);
  }
  const exportsValue = parsed.exports;
  const targets = new Map<string, string>();
  const rootTarget = runtimeTarget(exportsValue);
  if (rootTarget !== undefined) targets.set(".", rootTarget);
  if (isJsonObject(exportsValue)) {
    for (const [subpath, value] of Object.entries(exportsValue)) {
      if (subpath !== "." && !subpath.startsWith("./")) continue;
      const target = runtimeTarget(value);
      if (target !== undefined) targets.set(subpath, target);
    }
  }
  if (!targets.has(".")) {
    const fallbackTarget = typeof parsed.main === "string" ? parsed.main : parsed.types;
    if (typeof fallbackTarget === "string") targets.set(".", fallbackTarget);
  }
  return [parsed.name, { directory: dirname(manifest), exports: targets }];
};

const collectManifests = async (root: string): Promise<ReadonlyArray<string>> => {
  const manifests = ["core/package.json", "sdk/package.json", "container-runtime/package.json"];
  for await (const path of PLUGIN_MANIFEST_GLOB.scan({ cwd: root, onlyFiles: true })) {
    manifests.push(path);
  }
  return manifests.map((path) => resolve(root, path)).sort();
};

const collectSourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  for (const glob of [PACKAGE_SOURCE_GLOB, PLUGIN_SOURCE_GLOB]) {
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
      if (!TEST_FILE.test(path)) files.push(resolve(root, path));
    }
  }
  return [...new Set(files)].sort();
};

const resolveFile = (base: string, files: ReadonlySet<string>): string | undefined => {
  const extension = extname(base);
  const candidates = [base];
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  } else if (extension === "") {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`);
    candidates.push(
      join(base, "index.ts"),
      join(base, "index.tsx"),
      join(base, "index.mts"),
      join(base, "index.cts"),
    );
  }
  return candidates.find((candidate) => files.has(candidate));
};

const resolveWorkspaceSpecifier = (
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string | undefined => {
  for (const [name, pkg] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = pkg.exports.get(subpath);
    return target === undefined ? undefined : resolve(pkg.directory, target);
  }
  return undefined;
};

const stronglyConnectedComponents = (
  files: ReadonlyArray<string>,
  graph: ReadonlyMap<string, ReadonlyArray<RuntimeEdge>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];

  const visit = (file: string): void => {
    const index = nextIndex++;
    indices.set(file, index);
    lowlinks.set(file, index);
    stack.push(file);
    stacked.add(file);

    for (const edge of graph.get(file) ?? []) {
      const targetIndex = indices.get(edge.to);
      if (targetIndex === undefined) {
        visit(edge.to);
        const targetLowlink = lowlinks.get(edge.to);
        const fileLowlink = lowlinks.get(file);
        if (targetLowlink !== undefined && fileLowlink !== undefined) {
          lowlinks.set(file, Math.min(fileLowlink, targetLowlink));
        }
      } else if (stacked.has(edge.to)) {
        const fileLowlink = lowlinks.get(file);
        if (fileLowlink !== undefined) lowlinks.set(file, Math.min(fileLowlink, targetIndex));
      }
    }

    if (lowlinks.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      stacked.delete(member);
      component.push(member);
      if (member === file) break;
    }
    components.push(component.sort());
  };

  for (const file of files) if (!indices.has(file)) visit(file);
  return components;
};

const toRelative = (root: string, path: string): string => relative(root, path).replaceAll("\\", "/");

export const checkImportCycle = async ({
  root: rootInput,
}: CheckImportCycleOptions): Promise<ImportCycleResult> => {
  const root = resolve(rootInput);
  const packages = new Map(await Promise.all((await collectManifests(root)).map(readWorkspacePackage)));
  const files = await collectSourceFiles(root);
  const fileSet = new Set(files);
  const graph = new Map<string, ReadonlyArray<RuntimeEdge>>();

  await Promise.all(
    files.map(async (file) => {
      const runtimeEdges: RuntimeEdge[] = [];
      for (const edge of scanModuleEdges(file, await Bun.file(file).text())) {
        if (edge.typeOnly) continue;
        const base = edge.specifier.startsWith(".")
          ? resolve(dirname(file), edge.specifier)
          : resolveWorkspaceSpecifier(edge.specifier, packages);
        const target = base === undefined ? undefined : resolveFile(base, fileSet);
        if (target !== undefined)
          runtimeEdges.push({ from: file, to: target, line: edge.line, specifier: edge.specifier });
      }
      graph.set(
        file,
        runtimeEdges.sort((left, right) => left.to.localeCompare(right.to) || left.line - right.line),
      );
    }),
  );

  const cycles = stronglyConnectedComponents(files, graph)
    .filter(
      (component) =>
        component.length > 1 || graph.get(component[0] ?? "")?.some((edge) => edge.to === component[0]),
    )
    .map((component) => {
      const members = new Set(component);
      const edges = component.flatMap((file) =>
        (graph.get(file) ?? []).filter((edge) => members.has(edge.to)),
      );
      return {
        modules: component.map((file) => toRelative(root, file)),
        edges: edges.map((edge) => ({
          from: toRelative(root, edge.from),
          to: toRelative(root, edge.to),
          line: edge.line,
          specifier: edge.specifier,
        })),
      };
    })
    .sort((left, right) => left.modules.join("\0").localeCompare(right.modules.join("\0")));

  return { ok: cycles.length === 0, filesScanned: files.length, cycles };
};

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const result = await checkImportCycle({ root });
  if (result.ok) {
    process.stdout.write(`Import cycle check passed (${result.filesScanned} production modules).\n`);
  } else {
    const details = result.cycles.flatMap((cycle, index) => [
      `Cycle ${index + 1}: ${cycle.modules.join(" -> ")}`,
      ...cycle.edges.map(
        (edge) => `  ${edge.from}:${edge.line} imports ${edge.to} via ${JSON.stringify(edge.specifier)}`,
      ),
    ]);
    process.stderr.write(
      `Import cycle check failed. Break each runtime dependency cycle:\n${details.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
