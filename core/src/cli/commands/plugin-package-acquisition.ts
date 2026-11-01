import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import { NotImplementedError, PluginManifestError, PluginPackageOperationError } from "@lando/sdk/errors";
import {
  DEFAULT_NPM_REGISTRY_URL,
  defaultNpmRegistryClient,
  parseNpmPackageSpec,
  resolveNpmPackageVersion,
  verifyNpmPackageDistIntegrity,
} from "../../recipes/npm-source";
import { defaultTarballRecipeExtractor, defaultTarballRecipeFetcher } from "../../recipes/tarball-source";
import type { PluginAddOptions } from "./plugin-add-options";

export const ensurePluginsRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  const path = join(root, "package.json");
  if (!existsSync(path))
    await writeFile(
      path,
      `${JSON.stringify({ name: "lando-plugin-root", private: true, version: "0.0.0", description: "Managed by Lando." }, null, 2)}\n`,
    );
};

export const packageDeclaresPostinstall = async (packageDir: string): Promise<boolean> => {
  const packageJson: unknown = await readFile(join(packageDir, "package.json"), "utf8").then(
    (text) => {
      try {
        return JSON.parse(text);
      } catch (cause) {
        if (cause instanceof SyntaxError) return undefined;
        throw cause;
      }
    },
    () => undefined,
  );
  if (typeof packageJson !== "object" || packageJson === null || !("scripts" in packageJson)) return false;
  const scripts: unknown = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null || !("postinstall" in scripts)) return false;
  return typeof scripts.postinstall === "string" && scripts.postinstall.trim() !== "";
};

interface AcquiredPluginPackage {
  readonly created: boolean;
  readonly packageDir: string;
  readonly targetDir?: string;
  readonly stagingRoot?: string;
}

const acquisitionIssue = (message: string, spec: string) =>
  new NotImplementedError({
    message,
    commandId: "meta:plugin:add",
    remediation: `Check the npm package spec and registry metadata, then retry \`lando plugin:add ${spec}\`.`,
  });

const assertSafeInstallSegment = (value: string, label: string, spec: string): void => {
  const slashPath = value.replace(/\\/gu, "/");
  if (
    value.trim() === "" ||
    isAbsolute(value) ||
    slashPath.startsWith("/") ||
    value.includes("\\") ||
    slashPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw acquisitionIssue(`Resolved npm plugin ${label} escapes the plugin root: ${value}`, spec);
  }
};

export const acquirePluginPackage = async (
  options: PluginAddOptions,
  pluginsRoot: string,
): Promise<AcquiredPluginPackage> => {
  let operation: PluginPackageOperationError["operation"] = "resolve";
  try {
    const parsed = parseNpmPackageSpec(options.spec);
    const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
    const client = options.registryClient ?? defaultNpmRegistryClient(registryUrl);
    const packument = await client.fetchPackument(parsed.name);
    if (packument === undefined)
      throw acquisitionIssue(
        `npm package "${parsed.name}" was not found in the registry ${registryUrl}.`,
        options.spec,
      );
    const version = resolveNpmPackageVersion(packument, parsed.version, options.spec);
    const dist = packument.versions?.[version]?.dist;
    if (dist === undefined || dist.tarball === undefined || dist.tarball.trim() === "")
      throw acquisitionIssue(
        `npm package "${parsed.name}@${version}" has no published tarball URL.`,
        options.spec,
      );
    assertSafeInstallSegment(parsed.name, "name", options.spec);
    assertSafeInstallSegment(version, "version", options.spec);
    const packageDir = join(pluginsRoot, parsed.name, version);
    const rel = relative(pluginsRoot, packageDir);
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw acquisitionIssue(
        `Resolved npm plugin install path escapes the plugin root: ${packageDir}`,
        options.spec,
      );
    const exists = await stat(packageDir).then(
      () => true,
      () => false,
    );
    if (options.expectedActivation === undefined && exists) return { created: false, packageDir };
    operation = "download";
    const archiveBytes = await (options.fetcher ?? defaultTarballRecipeFetcher).fetch(dist.tarball);
    operation = "verify";
    verifyNpmPackageDistIntegrity(archiveBytes, dist, dist.tarball);
    operation = "extract";
    const finalParent = dirname(packageDir);
    await mkdir(finalParent, { recursive: true });
    const stagingRoot = await mkdtemp(join(finalParent, ".staging-"));
    try {
      await (options.extractor ?? defaultTarballRecipeExtractor).extract(archiveBytes, stagingRoot);
      const extractedPackageDir = join(stagingRoot, "package");
      await validatePluginManifest(extractedPackageDir);
      return { created: true, packageDir: extractedPackageDir, targetDir: packageDir, stagingRoot };
    } catch (cause) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof PluginManifestError) throw cause;
    throw new PluginPackageOperationError({
      message: `Plugin package ${operation} failed for ${options.spec}.`,
      commandId: "meta:plugin:add",
      operation,
      packageSpec: options.spec,
      cwd: pluginsRoot,
      detail: cause instanceof Error ? cause.message : String(cause),
      remediation: "Correct the reported package acquisition failure and retry plugin installation.",
    });
  }
};
