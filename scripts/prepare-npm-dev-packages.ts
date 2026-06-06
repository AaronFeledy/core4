#!/usr/bin/env bun
import { resolve } from "node:path";

import { buildConfig } from "../core/build.config.ts";

import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

type JsonObject = Record<string, unknown>;
type NpmDistTag = "dev" | "next";

export const betaPackageWorkspaces: ReadonlyArray<string> = [
  "sdk",
  "container-runtime",
  "core",
  ...buildConfig.bundledPlugins.map((plugin) => plugin.path),
];

export const betaPackageNames: ReadonlyArray<string> = [
  "@lando/sdk",
  "@lando/container-runtime",
  "@lando/core",
  ...buildConfig.bundledPlugins.map((plugin) => plugin.name),
];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const deriveNpmDevVersion = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicitVersion = env.LANDO_NPM_VERSION;
  if (explicitVersion !== undefined && explicitVersion !== "") return explicitVersion;

  const runNumber = env.GITHUB_RUN_NUMBER;
  if (runNumber === undefined || !/^\d+$/.test(runNumber)) {
    throw new Error("Set GITHUB_RUN_NUMBER or LANDO_NPM_VERSION before preparing npm dev packages.");
  }

  return `4.0.0-alpha.${runNumber}`;
};

export const deriveNpmBetaVersion = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicitVersion = env.LANDO_NPM_VERSION;
  if (explicitVersion !== undefined && explicitVersion !== "") return explicitVersion;

  const runNumber = env.GITHUB_RUN_NUMBER;
  if (runNumber === undefined || !/^\d+$/.test(runNumber)) {
    throw new Error("Set GITHUB_RUN_NUMBER or LANDO_NPM_VERSION before preparing npm beta packages.");
  }

  return `4.0.0-beta.${runNumber}`;
};

const rewriteWorkspaceRanges = (dependencies: unknown, version: string): JsonObject | undefined => {
  if (!isObject(dependencies)) return undefined;
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => [name, range === "workspace:*" ? version : range]),
  );
};

export const preparePackageJson = (
  packageJson: JsonObject,
  version: string,
  tag: NpmDistTag = "dev",
): JsonObject => {
  const dependencies = rewriteWorkspaceRanges(packageJson.dependencies, version);
  const peerDependencies = rewriteWorkspaceRanges(packageJson.peerDependencies, version);
  const optionalDependencies = rewriteWorkspaceRanges(packageJson.optionalDependencies, version);
  const devDependencies = rewriteWorkspaceRanges(packageJson.devDependencies, version);

  return {
    ...packageJson,
    version,
    private: false,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    publishConfig: {
      ...(isObject(packageJson.publishConfig) ? packageJson.publishConfig : {}),
      access: "public",
      tag,
      provenance: true,
    },
  };
};

const writePreparedPackage = async (
  relativePath: string,
  version: string,
  tag: NpmDistTag,
): Promise<void> => {
  const packagePath = resolve(REPO_ROOT, relativePath, "package.json");
  const packageJson = (await Bun.file(packagePath).json()) as JsonObject;
  await writeFormattedOutput(
    packagePath,
    `${JSON.stringify(preparePackageJson(packageJson, version, tag), null, 2)}\n`,
  );
  console.log(`[prepare-npm-dev-packages] ${relativePath} -> ${version} (${tag})`);
};

export const prepareNpmDevPackages = async (version = deriveNpmDevVersion()): Promise<void> => {
  await writePreparedPackage("sdk", version, "dev");
  await writePreparedPackage("core", version, "dev");
};

export const prepareNpmBetaPackages = async (version = deriveNpmBetaVersion()): Promise<void> => {
  for (const workspace of betaPackageWorkspaces) {
    await writePreparedPackage(workspace, version, "next");
  }
};

if (import.meta.main) {
  if (process.env.LANDO_NPM_DIST_TAG === "next") {
    await prepareNpmBetaPackages();
  } else {
    await prepareNpmDevPackages();
  }
}
