import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Effect } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner.ts";
import { validatePluginManifest } from "./plugin-add.ts";
import {
  PluginBuildMixedTreeError,
  assertNoMixedTrees,
  listOutputs,
  outputDirectoryExists,
} from "./plugin-build-files.ts";
import {
  commandError,
  declarationRootDir,
  entriesFromExports,
  readPackageJson,
  writeDistPackageJson,
} from "./plugin-build-package.ts";
import { findNearestPluginPackageRoot } from "./plugin-package-root.ts";

export { PluginBuildMixedTreeError };

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

const declarationTsconfigName = ".lando-plugin-build.tsconfig.json";

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );

const writeDeclarationTsconfig = async (
  pluginRoot: string,
  entries: ReadonlyArray<{ readonly source: string }>,
) => {
  const hasBaseTsconfig = await fileExists(join(pluginRoot, "tsconfig.json"));
  const config = {
    ...(hasBaseTsconfig ? { extends: "./tsconfig.json" } : {}),
    compilerOptions: {
      declaration: true,
      emitDeclarationOnly: true,
      outDir: "./dist",
      rootDir: declarationRootDir(entries),
      noEmit: false,
    },
    include: entries.map((entry) => entry.source),
  };
  await writeFile(join(pluginRoot, declarationTsconfigName), `${JSON.stringify(config, null, 2)}\n`);
};

const publishPluginBuildEvent = (event: Readonly<Record<string, unknown>>) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event as never).pipe(Effect.ignore) : Effect.void,
    ),
  );

export const pluginBuild = (
  options: PluginBuildOptions = {},
): Effect.Effect<PluginBuildResult, NotImplementedError | PluginManifestError | PluginBuildMixedTreeError> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const pluginRoot = yield* Effect.tryPromise({
      try: () => findNearestPluginPackageRoot(cwd, "meta:plugin:build"),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Unable to locate plugin root from ${resolve(cwd)}.`,
              issues: [String(cause)],
            }),
    });
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
    const buildRoot = declarationRootDir(entries);
    const buildArgv = [
      "build",
      ...entries.map((entry) => entry.source),
      "--outdir",
      "./dist",
      "--root",
      buildRoot,
      "--target",
      "bun",
      "--format",
      "esm",
    ];
    const declarationArgv = ["x", "tsc", "--project", declarationTsconfigName];
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
      yield* Effect.promise(() => writeDeclarationTsconfig(pluginRoot, entries));
      const declarations = yield* bunSelfRun({
        argv: declarationArgv,
        cwd: pluginRoot,
        verb: "build",
        callerSubsystem,
        ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
        ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
      });
      yield* Effect.promise(() => rm(join(pluginRoot, declarationTsconfigName), { force: true }));
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
