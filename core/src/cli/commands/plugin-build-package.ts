import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import { PluginManifestError } from "@lando/sdk/errors";

export interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly type?: unknown;
  readonly exports?: unknown;
  readonly landoPlugin?: unknown;
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
}

export interface ExportEntry {
  readonly key: string;
  readonly source: string;
  readonly js: string;
  readonly dts: string;
}

export const commandError = (message: string, remediation: string): PluginManifestError =>
  new PluginManifestError({ message, issues: [remediation] });

export const readPackageJson = async (pluginRoot: string): Promise<PackageJson> => {
  const raw = await readFile(join(pluginRoot, "package.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw commandError(`package.json in ${pluginRoot} is not valid JSON.`, String(cause));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw commandError(
      `package.json in ${pluginRoot} must be a JSON object.`,
      "Use an npm package.json object.",
    );
  }
  return parsed as PackageJson;
};

const exportSource = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const candidate = record.import ?? record.default;
  return typeof candidate === "string" ? candidate : undefined;
};

const normalizeEntrypoint = (pluginRoot: string, source: string): string => {
  const absolute = resolve(pluginRoot, source);
  const rel = relative(pluginRoot, absolute);
  if (rel.startsWith("..") || resolve(pluginRoot, rel) !== absolute) {
    throw commandError(
      `Plugin export ${source} escapes its package directory.`,
      "Keep package.json#exports entries inside the plugin package root.",
    );
  }
  return `./${rel.replace(/\\/g, "/")}`;
};

const distNamesForSource = (source: string): { readonly js: string; readonly dts: string } => {
  const parsed = source.replace(/^\.\//, "");
  const extension = extname(parsed);
  const name = basename(parsed, extension);
  return { js: `./${name}.js`, dts: `./${name}.d.ts` };
};

export const declarationRootDir = (entries: ReadonlyArray<ExportEntry>): string => {
  const sourceDirs = entries.map((entry) => {
    const withoutPrefix = entry.source.replace(/^\.\//, "");
    const slash = withoutPrefix.lastIndexOf("/");
    return slash === -1 ? "." : `./${withoutPrefix.slice(0, slash)}`;
  });
  const [first] = sourceDirs;
  if (first !== undefined && sourceDirs.every((dir) => dir === first)) return first;
  return ".";
};

export const entriesFromExports = (pluginRoot: string, exportsField: unknown): ReadonlyArray<ExportEntry> => {
  if (exportsField === undefined) {
    throw commandError(
      "meta:plugin:build requires package.json#exports.",
      'Add package.json#exports, for example { ".": "./src/index.ts" }.',
    );
  }
  if (typeof exportsField === "string") {
    const source = normalizeEntrypoint(pluginRoot, exportsField);
    return [{ key: ".", source, ...distNamesForSource(source) }];
  }
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) {
    throw commandError(
      "package.json#exports must be a string or object map for plugin builds.",
      'Use a simple exports map such as { ".": "./src/index.ts" }.',
    );
  }
  const entries: ExportEntry[] = [];
  for (const [key, value] of Object.entries(exportsField).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!key.startsWith(".")) continue;
    const rawSource = exportSource(value);
    if (rawSource === undefined) {
      throw commandError(
        `package.json#exports[${JSON.stringify(key)}] must declare a string import/default target.`,
        "Use TypeScript source entrypoints that Bun can build.",
      );
    }
    const source = normalizeEntrypoint(pluginRoot, rawSource);
    entries.push({ key, source, ...distNamesForSource(source) });
  }
  if (entries.length === 0) {
    throw commandError(
      "package.json#exports does not declare any plugin entrypoints.",
      'Add at least the default export entry, for example { ".": "./src/index.ts" }.',
    );
  }
  return entries;
};

const packageForDist = (pkg: PackageJson, entries: ReadonlyArray<ExportEntry>, entry: string) => {
  const exports: Record<string, { readonly types: string; readonly import: string }> = {};
  for (const item of entries) exports[item.key] = { types: item.dts, import: item.js };
  return {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type ?? "module",
    exports,
    types: entries.find((item) => item.key === ".")?.dts ?? entries[0]?.dts,
    dependencies: pkg.dependencies,
    peerDependencies: pkg.peerDependencies,
    landoPlugin:
      typeof pkg.landoPlugin === "object" && pkg.landoPlugin !== null && !Array.isArray(pkg.landoPlugin)
        ? { ...pkg.landoPlugin, entry }
        : pkg.landoPlugin,
  };
};

export const writeDistPackageJson = async (
  pluginRoot: string,
  pkg: PackageJson,
  entries: ReadonlyArray<ExportEntry>,
): Promise<void> => {
  const defaultEntry = entries.find((item) => item.key === ".") ?? entries[0];
  if (defaultEntry === undefined) return;
  const out = packageForDist(pkg, entries, defaultEntry.js);
  await writeFile(join(pluginRoot, "dist", "package.json"), `${JSON.stringify(out, null, 2)}\n`);
};
