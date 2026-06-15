import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

import { Data, Effect } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner.ts";
import { validatePluginManifest } from "./plugin-add.ts";

export class PluginBuildMixedTreeError extends Data.TaggedError("PluginBuildMixedTreeError")<{
  readonly message: string;
  readonly remediation: string;
  readonly path: string;
}> {}

export interface PluginBuildOptions {
  readonly cwd?: string;
  readonly spawner?: BunSelfSpawner;
  readonly execPath?: string;
}

export interface PluginBuildResult {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly entrypoints: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
  readonly exitCode: number;
}

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly type?: unknown;
  readonly exports?: unknown;
  readonly landoPlugin?: unknown;
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
}

interface ExportEntry {
  readonly key: string;
  readonly source: string;
  readonly js: string;
  readonly dts: string;
}

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const commandError = (message: string, remediation: string): PluginManifestError =>
  new PluginManifestError({ message, issues: [remediation] });

const readPackageJson = async (pluginRoot: string): Promise<PackageJson> => {
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

const entriesFromExports = (pluginRoot: string, exportsField: unknown): ReadonlyArray<ExportEntry> => {
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

const findNestedDist = async (dir: string): Promise<string | undefined> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissingPathError(cause)) return [];
    throw cause;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "dist") return path;
    const nested = await findNestedDist(path);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const assertNoMixedTrees = async (pluginRoot: string, entries: ReadonlyArray<ExportEntry>): Promise<void> => {
  const nestedDist = await findNestedDist(join(pluginRoot, "src"));
  if (nestedDist !== undefined) {
    throw new PluginBuildMixedTreeError({
      message: `Plugin source tree contains build output at ${nestedDist}.`,
      remediation: "Remove dist output from src/ before running meta:plugin:build.",
      path: nestedDist,
    });
  }
  const hasSourceEntry = entries.some((entry) => entry.source.startsWith("./src/"));
  const hasDistEntry = entries.some((entry) => entry.source.startsWith("./dist/"));
  if (hasSourceEntry && hasDistEntry) {
    throw new PluginBuildMixedTreeError({
      message: "package.json#exports mixes source and dist entrypoints.",
      remediation:
        "Point exports at source entrypoints before building; meta:plugin:build writes dist/package.json.",
      path: join(pluginRoot, "package.json"),
    });
  }
};

const publishPluginBuildEvent = (event: Readonly<Record<string, unknown>>) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event as never).pipe(Effect.ignore) : Effect.void,
    ),
  );

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

const writeDistPackageJson = async (
  pluginRoot: string,
  pkg: PackageJson,
  entries: ReadonlyArray<ExportEntry>,
): Promise<void> => {
  const defaultEntry = entries.find((item) => item.key === ".") ?? entries[0];
  if (defaultEntry === undefined) return;
  const out = packageForDist(pkg, entries, defaultEntry.js);
  await writeFile(join(pluginRoot, "dist", "package.json"), `${JSON.stringify(out, null, 2)}\n`);
};

const listOutputs = async (pluginRoot: string): Promise<ReadonlyArray<string>> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      out.push(relative(pluginRoot, absolute).replace(/\\/g, "/"));
    }
  };
  await walk(join(pluginRoot, "dist"));
  return out.sort((left, right) => left.localeCompare(right));
};

const outputDirectoryExists = async (pluginRoot: string): Promise<boolean> =>
  stat(join(pluginRoot, "dist")).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

export const pluginBuild = (
  options: PluginBuildOptions = {},
): Effect.Effect<PluginBuildResult, NotImplementedError | PluginManifestError | PluginBuildMixedTreeError> =>
  Effect.gen(function* () {
    const pluginRoot = resolve(options.cwd ?? process.cwd());
    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(pluginRoot),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin manifest validation failed in ${pluginRoot}.`,
              issues: [String(cause)],
            }),
    });
    const pkg = yield* Effect.tryPromise({
      try: () => readPackageJson(pluginRoot),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Unable to read package.json in ${pluginRoot}.`,
              issues: [String(cause)],
            }),
    });
    const entries = yield* Effect.tryPromise({
      try: async () => entriesFromExports(pluginRoot, pkg.exports),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : commandError("Invalid package exports.", String(cause)),
    });
    yield* Effect.tryPromise({
      try: () => assertNoMixedTrees(pluginRoot, entries),
      catch: (cause) =>
        cause instanceof PluginBuildMixedTreeError
          ? cause
          : new PluginBuildMixedTreeError({
              message: `Unable to inspect plugin source tree at ${pluginRoot}.`,
              remediation: String(cause),
              path: join(pluginRoot, "src"),
            }),
    });
    yield* Effect.promise(() => mkdir(join(pluginRoot, "dist"), { recursive: true }));
    const callerSubsystem = `plugin-authoring:meta:plugin:build:${manifest.name}`;
    const buildArgv = [
      "build",
      ...entries.map((entry) => entry.source),
      "--outdir",
      "./dist",
      "--target",
      "bun",
      "--format",
      "esm",
    ];
    const declarationArgv = [
      "x",
      "tsc",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      "./dist",
      "--noEmit",
      "false",
    ];
    yield* publishPluginBuildEvent({
      _tag: "cli-meta:plugin:build-start",
      pluginName: manifest.name,
      pluginRoot,
      entrypoints: entries.map((entry) => entry.source),
      timestamp: new Date().toISOString(),
    });
    const build = yield* bunSelfRun({
      argv: buildArgv,
      cwd: pluginRoot,
      verb: "build",
      callerSubsystem,
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    });
    let declarationExitCode = 0;
    if (build.exitCode === 0) {
      const declarations = yield* bunSelfRun({
        argv: declarationArgv,
        cwd: pluginRoot,
        verb: "build",
        callerSubsystem,
        ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
        ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
      });
      declarationExitCode = declarations.exitCode;
    }
    const exitCode = build.exitCode === 0 ? declarationExitCode : build.exitCode;
    if (exitCode === 0) yield* Effect.promise(() => writeDistPackageJson(pluginRoot, pkg, entries));
    const outputs = (yield* Effect.promise(() => outputDirectoryExists(pluginRoot)))
      ? yield* Effect.promise(() => listOutputs(pluginRoot))
      : [];
    yield* publishPluginBuildEvent({
      _tag: "cli-meta:plugin:build-complete",
      pluginName: manifest.name,
      pluginRoot,
      entrypoints: entries.map((entry) => entry.source),
      outputs,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    return {
      pluginName: manifest.name,
      pluginRoot,
      entrypoints: entries.map((entry) => entry.source),
      outputs,
      exitCode,
    };
  });

export const renderPluginBuildResult = (result: PluginBuildResult): string =>
  [
    `plugin-build: ${result.pluginName}`,
    `entrypoints: ${result.entrypoints.join(", ")}`,
    `outputs: ${result.outputs.join(", ")}`,
    `result: ${result.exitCode === 0 ? "built" : `failed (exit ${result.exitCode})`}`,
  ].join("\n");
