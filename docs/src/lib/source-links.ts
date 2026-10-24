import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { slug } from "github-slugger";
import { glob } from "tinyglobby";
import { parse as parseYaml } from "yaml";

export const docsPatterns = [
  "reference/**/*.mdx",
  "contributing/*.md",
  "telemetry/*.md",
  "*.md",
  "guides/**/*.mdx",
  "!src/**",
  "!dist/**",
  "!node_modules/**",
  "!.astro/**",
] as const;

export type SourceLinkInventory = {
  readonly repoRoot: string;
  readonly base: string;
  readonly pages: ReadonlyMap<string, string>;
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
  readonly schemas: ReadonlyMap<string, string>;
};

const slash = (path: string): string => path.split(sep).join("/");
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const sitePath = (base: string, path: string): string => `${base}${path.replace(/^\/+/, "")}`;

// Matches Astro glob's default ID: frontmatter slug, otherwise slugified path segments.
export const docsPageId = (entry: string, data: Record<string, unknown>): string =>
  data.slug
    ? String(data.slug)
    : entry
        .replace(/\.[^.]+$/, "")
        .split("/")
        .map((part) => slug(part))
        .join("/")
        .replace(/\/index$/, "");

export const createSourceLinkInventory = async (
  repoRoot: string,
  base: string,
): Promise<SourceLinkInventory> => {
  const root = await realpath(repoRoot);
  const docsRoot = resolve(root, "docs");
  const pages = new Map<string, string>();
  for (const entry of await glob([...docsPatterns], {
    cwd: docsRoot,
    followSymbolicLinks: false,
    expandDirectories: false,
  })) {
    const path = resolve(docsRoot, entry);
    if (!within(root, await realpath(path))) continue;
    const source = await readFile(path, "utf8");
    const frontmatter = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(source)?.[1];
    const data: unknown = frontmatter === undefined ? {} : parseYaml(frontmatter);
    const metadata = typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
    pages.set(path, docsPageId(slash(entry), metadata as Record<string, unknown>));
  }
  for (const entry of await glob("*/README.mdx", {
    cwd: resolve(root, "recipes"),
    followSymbolicLinks: false,
    expandDirectories: false,
  })) {
    const path = resolve(root, "recipes", entry);
    if (within(root, await realpath(path)))
      pages.set(path, `recipes/${slash(entry).replace(/\/README\.mdx$/, "")}`);
  }

  // Only Git-tracked repository paths have a meaningful blob/tree destination.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of tracked.split("\0").filter(Boolean)) {
    const path = resolve(root, entry);
    if (!within(root, path)) continue;
    try {
      if (!within(root, await realpath(path))) continue;
    } catch {
      continue;
    }
    files.add(path);
    for (let parent = dirname(path); parent !== root && within(root, parent); parent = dirname(parent))
      directories.add(parent);
  }
  const schemas = new Map<string, string>();
  // These are generated before docs:build. Never link ignored build products to GitHub.
  const schemaEntries = await readdir(resolve(root, "dist/schemas"), { withFileTypes: true }).catch(
    (error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    },
  );
  for (const entry of schemaEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const source = resolve(root, "dist/schemas", entry.name);
    if (!within(root, await realpath(source))) throw new Error(`Schema source escapes repository: ${source}`);
    schemas.set(source, `schemas/${entry.name}`);
  }
  return {
    repoRoot: root,
    base: `/${base.split("/").filter(Boolean).join("/")}/`.replace(/\/+/g, "/"),
    pages,
    files,
    directories,
    schemas,
  };
};

export const resolveSourceLink = (
  url: string,
  sourceFile: string,
  inventory: SourceLinkInventory,
): string => {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(url) || url === "") return url;
  const split = url.search(/[?#]/);
  const pathname = split < 0 ? url : url.slice(0, split);
  const suffix = split < 0 ? "" : url.slice(split);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return url;
  }
  const { repoRoot, base, pages, files, directories, schemas } = inventory;
  if (decoded.startsWith("/")) {
    if (base !== "/" && decoded.startsWith(base)) return url;
    const route = decoded.replace(/^\/+|\/+$/g, "");
    if ([...pages.values()].some((id) => (id === "index" ? "" : id.replace(/^\/+|\/+$/g, "")) === route)) {
      return `${sitePath(base, route)}${route === "" ? "" : "/"}${suffix}`;
    }
    return url;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return url;
  const source = resolve(sourceFile);
  if (!within(repoRoot, source)) return url;
  const target = resolve(dirname(source), decoded);
  if (!within(repoRoot, target)) return url;
  const page = pages.get(target);
  if (page !== undefined) {
    const route = page === "index" ? "" : page.replace(/^\/+|\/+$/g, "");
    return `${sitePath(base, encodePath(route))}${route === "" ? "" : "/"}${suffix}`;
  }
  const schema = schemas.get(target);
  if (schema !== undefined) return `${sitePath(base, encodePath(schema))}${suffix}`;
  if (!files.has(target) && !directories.has(target)) return url;
  const kind = files.has(target) ? "blob" : "tree";
  return `https://github.com/AaronFeledy/core4/${kind}/main/${encodePath(slash(relative(repoRoot, target)))}${suffix}`;
};

export const publishSchemaAssets = async (inventory: SourceLinkInventory, output: string): Promise<void> => {
  for (const [source, asset] of inventory.schemas) {
    const destination = resolve(output, asset);
    if (!within(output, destination)) throw new Error(`Schema asset escapes output: ${asset}`);
    await mkdir(dirname(destination), { recursive: true });
    // The two existing editor schemas keep their own URLs and bytes.
    if (asset === "schemas/landofile.schema.json" || asset === "schemas/global-config.schema.json") {
      throw new Error(`Generated schema collides with editor schema: ${asset}`);
    }
    await copyFile(source, destination);
  }
};
