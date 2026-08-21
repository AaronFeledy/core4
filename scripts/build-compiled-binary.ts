#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { BunPlugin } from "bun";

import { CI_PLATFORMS, type CiPlatform } from "./ci-platforms.ts";
import { CompiledBinaryVersionError, resolveCompiledBinaryVersion } from "./compiled-binary-version.ts";
import { opentuiNativeCatalog } from "./generated/opentui-native/catalog.generated.ts";

export { CompiledBinaryVersionError } from "./compiled-binary-version.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTFILE = resolve(REPO_ROOT, "core/dist/lando");

export interface CompiledBinaryOptions {
  readonly target?: string;
  readonly outfile: string;
  readonly version?: string;
  readonly metafileMd?: string;
}

export type CompiledBinaryBuildRunner = (config: Bun.BuildConfig) => Promise<Bun.BuildOutput>;

export class CompiledBinaryBuildError extends Error {
  override readonly name = "CompiledBinaryBuildError";

  constructor(readonly diagnostics: ReadonlyArray<Bun.BuildOutput["logs"][number]>) {
    const details = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    super(`Compiled binary build failed.${details === "" ? "" : `\n${details}`}`);
  }
}

const platformFor = (target: string): CiPlatform => {
  const platform = CI_PLATFORMS.find(
    (candidate) => candidate.id === target || candidate.bunTarget === target,
  );
  if (platform === undefined) throw new Error(`Unknown Lando release target: ${target}.`);
  return platform;
};

const bunTargetFor = (platform: CiPlatform): Bun.Build.CompileTarget => {
  switch (platform.bunTarget) {
    case "bun-darwin-arm64":
    case "bun-darwin-x64":
    case "bun-linux-arm64":
    case "bun-linux-x64":
    case "bun-windows-x64":
    case "bun-windows-arm64":
      return platform.bunTarget;
    default:
      throw new Error(`Unsupported Bun compile target: ${platform.bunTarget}.`);
  }
};

const hostTarget = (): string =>
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

const nativeRootFor = (target: string): string => {
  const root = Object.entries(opentuiNativeCatalog.targetToNativeRoot).find(
    ([candidate]) => candidate === target,
  )?.[1];
  if (root === undefined) throw new Error(`Unknown Lando release target: ${target}.`);
  return root;
};

export const resolveOpenTuiNativeImport = (target: string, path: string): string | undefined => {
  if (!opentuiNativeCatalog.rootImportFilter.test(path)) return undefined;
  const targetNativeRoot = nativeRootFor(target);
  if (targetNativeRoot === path) return undefined;
  return opentuiNativeCatalog.stubPathFor(target, path);
};

export const createOpenTuiPruningPlugin = (target: string): BunPlugin => ({
  name: "opentui-native-pruning",
  setup(build) {
    build.onResolve({ filter: opentuiNativeCatalog.rootImportFilter }, ({ path }) => {
      const resolvedPath = resolveOpenTuiNativeImport(target, path);
      return resolvedPath === undefined ? undefined : { path: resolvedPath };
    });
  },
});

const emitMetafileMarkdown = async (options: CompiledBinaryOptions): Promise<void> => {
  if (options.metafileMd === undefined) return;

  const metafileMd = resolve(options.metafileMd);
  const stagingDir = await mkdtemp(resolve(tmpdir(), "lando-compile-metafile-"));
  try {
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        resolve(REPO_ROOT, "core/bin/lando.ts"),
        "--target=bun",
        "--format=esm",
        `--outfile=${resolve(stagingDir, "lando.js")}`,
        `--metafile-md=${metafileMd}`,
      ],
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`bun build --metafile-md failed with exit code ${exitCode}.`);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};

export const buildCompiledBinary = async (
  options: CompiledBinaryOptions,
  build: CompiledBinaryBuildRunner = (config) => Bun.build(config),
): Promise<Bun.BuildOutput> => {
  const platform = platformFor(options.target ?? hostTarget());
  const output = await build({
    entrypoints: [resolve(REPO_ROOT, "core/bin/lando.ts")],
    target: "bun",
    format: "esm",
    splitting: true,
    // Bun 1.4 compiled binaries no longer auto-load tsconfig.json / package.json
    // (CompileBuildOptions.autoloadTsconfig / autoloadPackageJson default false).
    // Keep version and OpenTUI metadata on `define`; enable autoload only if
    // relocated-binary smoke fails with a missing package/path diagnostic.
    compile: { target: bunTargetFor(platform), outfile: options.outfile },
    bytecode: true,
    minify: true,
    sourcemap: "external",
    define: {
      __LANDO_OPENTUI_NATIVE_ROOT__: JSON.stringify(nativeRootFor(platform.id)),
      __LANDO_CORE_VERSION__: JSON.stringify(
        resolveCompiledBinaryVersion({
          ...(options.version === undefined ? {} : { explicit: options.version }),
          cwd: REPO_ROOT,
        }),
      ),
    },
    plugins: [createOpenTuiPruningPlugin(platform.id)],
  });
  if (!output.success) throw new CompiledBinaryBuildError(output.logs);
  await emitMetafileMarkdown(options);
  return output;
};

export const parseCompiledBinaryArgs = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CompiledBinaryOptions => {
  let target: string | undefined;
  let outfile = DEFAULT_OUTFILE;
  let version: string | undefined;
  let metafileMd: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      throw new Error("Unexpected empty compiled binary argument.");
    }
    if (arg === "--") continue;
    if (arg === "--minify") continue;

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (
      flag !== "--target" &&
      flag !== "--outfile" &&
      flag !== "--version" &&
      flag !== "--sourcemap" &&
      flag !== "--metafile-md"
    ) {
      throw new Error(`Unknown compiled binary argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} expects a value.`);
    }
    if (inlineValue === undefined) index += 1;

    if (flag === "--sourcemap") {
      if (value !== "external") throw new Error("--sourcemap must be external.");
      continue;
    }

    if (flag === "--target") target = platformFor(value).id;
    if (flag === "--outfile") outfile = value;
    if (flag === "--version") version = value;
    if (flag === "--metafile-md") metafileMd = value;
  }

  if (metafileMd === undefined && env.LANDO_COMPILE_METAFILE === "1") {
    metafileMd = `${outfile}.metafile.md`;
  }

  return {
    ...(target === undefined ? {} : { target }),
    outfile,
    ...(version === undefined ? {} : { version }),
    ...(metafileMd === undefined ? {} : { metafileMd }),
  };
};

if (import.meta.main) {
  try {
    await buildCompiledBinary(parseCompiledBinaryArgs(Bun.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof CompiledBinaryBuildError || error instanceof CompiledBinaryVersionError)) {
      throw error;
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}
