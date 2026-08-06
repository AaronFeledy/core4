import { dirname, extname, join, resolve } from "node:path";

export interface WorkspacePackage {
  readonly directory: string;
  readonly exports: ReadonlyMap<string, string>;
}

export interface RuntimeEdge {
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

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readWorkspacePatterns = async (root: string): Promise<readonly string[]> => {
  const manifest = resolve(root, "package.json");
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  if (!isJsonObject(parsed) || !Array.isArray(parsed.workspaces)) {
    throw new TypeError(`Invalid root workspace manifest: ${manifest}`);
  }
  const patterns = parsed.workspaces.filter((value): value is string => typeof value === "string");
  if (patterns.length !== parsed.workspaces.length) {
    throw new TypeError(`Invalid root workspace manifest: ${manifest}`);
  }
  return patterns;
};

const runtimeTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!isJsonObject(value)) return undefined;
  const importTarget = value.import;
  if (typeof importTarget === "string") return importTarget;
  const typesTarget = value.types;
  return typeof typesTarget === "string" ? typesTarget : undefined;
};

export const readWorkspacePackage = async (
  manifest: string,
): Promise<readonly [string, WorkspacePackage]> => {
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

export const collectManifests = async (root: string): Promise<readonly string[]> => {
  const manifests = new Set<string>();
  for (const workspace of await readWorkspacePatterns(root)) {
    const manifestGlob = new Bun.Glob(`${workspace.replace(/\/$/u, "")}/package.json`);
    for await (const path of manifestGlob.scan({ cwd: root, onlyFiles: true })) {
      manifests.add(resolve(root, path));
    }
  }
  return [...manifests].sort();
};

export const loadWorkspacePackages = async (root: string): Promise<ReadonlyMap<string, WorkspacePackage>> =>
  new Map(await Promise.all((await collectManifests(root)).map(readWorkspacePackage)));

export const resolveFile = (base: string, files: ReadonlySet<string>): string | undefined => {
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

export const resolveWorkspaceSpecifier = (
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string | undefined => {
  for (const [name, workspacePackage] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = workspacePackage.exports.get(subpath);
    return target === undefined ? undefined : resolve(workspacePackage.directory, target);
  }
  return undefined;
};

export const stronglyConnectedComponents = (
  files: readonly string[],
  graph: ReadonlyMap<string, readonly RuntimeEdge[]>,
): readonly (readonly string[])[] => {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];

  const visit = (file: string): number => {
    const index = nextIndex++;
    let lowlink = index;
    indices.set(file, index);
    stack.push(file);
    stacked.add(file);

    for (const edge of graph.get(file) ?? []) {
      const targetIndex = indices.get(edge.to);
      if (targetIndex === undefined) {
        lowlink = Math.min(lowlink, visit(edge.to));
      } else if (stacked.has(edge.to)) {
        lowlink = Math.min(lowlink, targetIndex);
      }
    }

    if (lowlink !== index) return lowlink;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      stacked.delete(member);
      component.push(member);
      if (member === file) break;
    }
    components.push(component.sort());
    return lowlink;
  };

  for (const file of files) if (!indices.has(file)) visit(file);
  return components;
};
