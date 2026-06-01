#!/usr/bin/env bun
import { resolve } from "node:path";

import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

type JsonObject = Record<string, unknown>;

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

export const preparePackageJson = (packageJson: JsonObject, version: string): JsonObject => {
  const dependencies = isObject(packageJson.dependencies) ? { ...packageJson.dependencies } : undefined;
  if (packageJson.name === "@lando/core") {
    if (dependencies === undefined) throw new Error("@lando/core package.json must declare dependencies.");
    dependencies["@lando/sdk"] = version;
  }

  return {
    ...packageJson,
    version,
    private: false,
    ...(dependencies === undefined ? {} : { dependencies }),
    publishConfig: {
      ...(isObject(packageJson.publishConfig) ? packageJson.publishConfig : {}),
      access: "public",
      tag: "dev",
      provenance: true,
    },
  };
};

const writePreparedPackage = async (relativePath: string, version: string): Promise<void> => {
  const packagePath = resolve(REPO_ROOT, relativePath, "package.json");
  const packageJson = (await Bun.file(packagePath).json()) as JsonObject;
  await writeFormattedOutput(
    packagePath,
    `${JSON.stringify(preparePackageJson(packageJson, version), null, 2)}\n`,
  );
  console.log(`[prepare-npm-dev-packages] ${relativePath} -> ${version}`);
};

export const prepareNpmDevPackages = async (version = deriveNpmDevVersion()): Promise<void> => {
  await writePreparedPackage("sdk", version);
  await writePreparedPackage("core", version);
};

if (import.meta.main) await prepareNpmDevPackages();
