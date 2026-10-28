import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { Cause, DateTime, Effect, Exit, Schema } from "effect";

import {
  annotateFailureRole,
  commandCompletionFromExitCode,
  failureDefectCause,
  mergeFailure,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";
import { FileIoError, type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";

import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner";
import { publishOptionalEvent } from "./optional-event-publish";
import {
  PluginBuildMixedTreeError,
  assertNoMixedTrees,
  listOutputs,
  outputDirectoryExists,
} from "./plugin-build-files";
import {
  commandError,
  declarationRootDir,
  entriesFromExports,
  readPackageJson,
  writeDistPackageJson,
} from "./plugin-build-package";
import { resolvePluginPackageRoot } from "./plugin-package-root";

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

export const PluginBuildResultSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginRoot: Schema.String,
  entrypoints: Schema.Array(Schema.String),
  outputs: Schema.Array(Schema.String),
  exitCode: Schema.Number,
});

const declarationTsconfigName = () => `.lando-plugin-build.${crypto.randomUUID()}.tsconfig.json`;

const declarationConfigError = (path: string, action: string, cause: unknown): FileIoError =>
  new FileIoError({
    message: `Unable to ${action} the temporary plugin declaration config at ${path}.`,
    path,
    cause,
    remediation: `Inspect ${path} and the plugin directory permissions, then retry the build.`,
  });

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );

const declarationTsconfigContents = async (
  pluginRoot: string,
  entries: ReadonlyArray<{ readonly source: string }>,
): Promise<string> => {
  const hasBaseTsconfig = await fileExists(join(pluginRoot, "tsconfig.json"));
  const config = {
    ...(hasBaseTsconfig ? { extends: "./tsconfig.json" } : {}),
    compilerOptions: {
      composite: false,
      incremental: false,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: "./dist",
      rootDir: declarationRootDir(entries),
      noEmit: false,
    },
    include: entries.map((entry) => entry.source),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
};

export const pluginBuild = Effect.fn("PluginBuild.build")(function* (
  options: PluginBuildOptions = {},
): Effect.fn.Return<
  PluginBuildResult,
  NotImplementedError | FileIoError | PluginManifestError | PluginBuildMixedTreeError
> {
  const pluginRoot = yield* resolvePluginPackageRoot(options.cwd, "meta:plugin:build");
  const { manifest } = yield* Effect.tryPromise({
    try: () => validatePluginManifest(pluginRoot),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Plugin manifest validation failed in ${pluginRoot}.`,
            issues: [{ path: [], message: String(cause) }],
            remediation: `Check package.json in ${pluginRoot} and correct the reported manifest issues.`,
          }),
  });
  const pkg = yield* Effect.tryPromise({
    try: () => readPackageJson(pluginRoot),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Unable to read package.json in ${pluginRoot}.`,
            issues: [{ path: [], message: String(cause) }],
            remediation: `Make package.json in ${pluginRoot} readable and valid JSON.`,
          }),
  });
  const entries = yield* Effect.tryPromise({
    try: async () => entriesFromExports(pluginRoot, pkg.exports),
    catch: (cause) =>
      cause instanceof PluginManifestError ? cause : commandError("Invalid package exports.", String(cause)),
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
    "--splitting",
    "--external",
    "@lando/sdk",
    "--external",
    "@lando/sdk/*",
    "--external",
    "effect",
    "--external",
    "effect/*",
  ];
  yield* publishOptionalEvent({
    _tag: "cli-meta:plugin:build-start",
    pluginName: manifest.name,
    pluginRoot,
    entrypoints: entries.map((entry) => entry.source),
    timestamp: DateTime.formatIso(yield* DateTime.now),
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
    const configContents = yield* Effect.tryPromise({
      try: () => declarationTsconfigContents(pluginRoot, entries),
      catch: (cause) => declarationConfigError(join(pluginRoot, "tsconfig.json"), "read", cause),
    });
    const configName = declarationTsconfigName();
    const configPath = join(pluginRoot, configName);
    const declarations = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => ({ file: await open(configPath, "wx", 0o600), path: configPath }),
        catch: (cause) => declarationConfigError(configPath, "create", cause),
      }),
      ({ file }) =>
        Effect.gen(function* () {
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () => file.writeFile(configContents),
                catch: (cause) => declarationConfigError(configPath, "write", cause),
              });
              yield* Effect.tryPromise({
                try: () => file.close(),
                catch: (cause) => declarationConfigError(configPath, "close", cause),
              });
            }),
          );
          return yield* bunSelfRun({
            argv: ["x", "tsc", "--project", configName],
            cwd: pluginRoot,
            verb: "build",
            callerSubsystem,
            ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
            ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
          });
        }),
      ({ file, path }, exit) =>
        Effect.gen(function* () {
          const closeExit = yield* Effect.exit(
            Effect.tryPromise({
              try: () => file.close(),
              catch: (cause) => declarationConfigError(path, "close", cause),
            }),
          );
          const removeExit = yield* Effect.exit(
            Effect.tryPromise({
              try: () => rm(path, { force: true }),
              catch: (cause) => declarationConfigError(path, "remove", cause),
            }),
          );
          let cleanupCause: Cause.Cause<FileIoError> = Cause.empty;
          if (Exit.isFailure(closeExit))
            cleanupCause = mergeFailure(cleanupCause, closeExit.cause, "cleanup");
          if (Exit.isFailure(removeExit))
            cleanupCause = mergeFailure(cleanupCause, removeExit.cause, "cleanup");
          if (cleanupCause.reasons.length === 0) return;
          if (Exit.isSuccess(exit) && exit.value.exitCode !== 0) {
            const completion = resolveCommandCompletion("meta:plugin:build", exit.value, (result) =>
              commandCompletionFromExitCode(result.exitCode),
            );
            if (completion._tag === "failure") {
              return yield* Effect.failCause(
                failureDefectCause(mergeFailure(Cause.fail(completion.error), cleanupCause, "cleanup")),
              );
            }
          }
          return yield* Effect.failCause(failureDefectCause(annotateFailureRole(cleanupCause, "cleanup")));
        }),
    );
    declarationExitCode = declarations.exitCode;
  }
  const exitCode = build.exitCode === 0 ? declarationExitCode : build.exitCode;
  if (exitCode === 0) yield* Effect.promise(() => writeDistPackageJson(pluginRoot, pkg, entries));
  const outputs = (yield* Effect.promise(() => outputDirectoryExists(pluginRoot)))
    ? yield* Effect.promise(() => listOutputs(pluginRoot))
    : [];
  yield* publishOptionalEvent({
    _tag: "cli-meta:plugin:build-complete",
    pluginName: manifest.name,
    pluginRoot,
    entrypoints: entries.map((entry) => entry.source),
    outputs,
    exitCode,
    timestamp: DateTime.formatIso(yield* DateTime.now),
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
