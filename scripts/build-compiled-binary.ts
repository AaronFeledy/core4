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

const platformFor = (target: string): CiPlatform => {
  const platform = CI_PLATFORMS.find((candidate) => candidate.id === target);
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

export const resolveOpenTuiNativeImport = (target: string, path: string): string | undefined => {
  if (!opentuiNativeCatalog.rootImportFilter.test(path)) return undefined;
  const targetNativeRoot = Object.entries(opentuiNativeCatalog.targetToNativeRoot).find(
    ([candidate]) => candidate === target,
  )?.[1];
  if (targetNativeRoot === undefined) throw new Error(`Unknown Lando release target: ${target}.`);
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
  const target = options.target ?? hostTarget();
  const platform = platformFor(target);
  return build({
    entrypoints: [resolve(REPO_ROOT, "core/bin/lando.ts")],
    target: "bun",
    format: "esm",
    compile: { target: bunTargetFor(platform), outfile: options.outfile },
    bytecode: true,
    sourcemap: "external",
    ...(options.version === undefined
      ? {}
      : { define: { __LANDO_CORE_VERSION__: JSON.stringify(options.version) } }),
    plugins: [createOpenTuiPruningPlugin(target)],
  });
};

export const parseCompiledBinaryArgs = (args: readonly string[]): CompiledBinaryOptions => {
  let target: string | undefined;
  let outfile = DEFAULT_OUTFILE;
  let version: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    if (flag !== "--target" && flag !== "--outfile" && flag !== "--version") {
      throw new Error(`Unknown compiled binary argument: ${arg}`);
    }
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} expects a value.`);
    }
    if (inlineValue === undefined) index += 1;

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
  await buildCompiledBinary(parseCompiledBinaryArgs(Bun.argv.slice(2)));
}
