#!/usr/bin/env bun
import { resolve } from "node:path";

import type { BunPlugin } from "bun";

import { CI_PLATFORMS, type CiPlatform } from "./ci-platforms.ts";
import { opentuiNativeCatalog } from "./generated/opentui-native/catalog.generated.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTFILE = resolve(REPO_ROOT, "core/dist/lando");

export interface CompiledBinaryOptions {
  readonly target?: string;
  readonly outfile: string;
  readonly version?: string;
}

export type CompiledBinaryBuildRunner = (config: Bun.BuildConfig) => Promise<Bun.BuildOutput>;

export class CompiledBinaryBuildError extends Error {
  readonly name = "CompiledBinaryBuildError";

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
    compile: { target: bunTargetFor(platform), outfile: options.outfile },
    bytecode: true,
    minify: true,
    sourcemap: "external",
    define: {
      __LANDO_OPENTUI_NATIVE_ROOT__: JSON.stringify(nativeRootFor(platform.id)),
      ...(options.version === undefined ? {} : { __LANDO_CORE_VERSION__: JSON.stringify(options.version) }),
    },
    plugins: [createOpenTuiPruningPlugin(platform.id)],
  });
  if (!output.success) throw new CompiledBinaryBuildError(output.logs);
  return output;
};

export const parseCompiledBinaryArgs = (args: readonly string[]): CompiledBinaryOptions => {
  let target: string | undefined;
  let outfile = DEFAULT_OUTFILE;
  let version: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--minify") continue;

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (flag !== "--target" && flag !== "--outfile" && flag !== "--version" && flag !== "--sourcemap") {
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
  }

  return {
    ...(target === undefined ? {} : { target }),
    outfile,
    ...(version === undefined ? {} : { version }),
  };
};

if (import.meta.main) {
  try {
    await buildCompiledBinary(parseCompiledBinaryArgs(Bun.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof CompiledBinaryBuildError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
