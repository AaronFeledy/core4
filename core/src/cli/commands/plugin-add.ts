import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
  RecipeSourceError,
} from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService, PluginTrustStore as PersistentPluginTrustStore } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "../../cache/command-index-writer.ts";
import { recordInstalledPlugin } from "../../plugins/installed-registry.ts";
import { publish } from "../../recipes/git-source.ts";
import {
  DEFAULT_NPM_REGISTRY_URL,
  type NpmPackument,
  type NpmRegistryClient,
  defaultNpmRegistryClient,
  parseNpmPackageSpec,
  resolveNpmPackageVersion,
  verifyNpmPackageDistIntegrity,
} from "../../recipes/npm-source.ts";
import { createStdioPromptIO } from "../../recipes/prompts/io.ts";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  defaultTarballRecipeExtractor,
  defaultTarballRecipeFetcher,
} from "../../recipes/tarball-source.ts";

export interface PluginAddSpawner {
  readonly install: (request: {
    readonly spec: string;
    readonly cwd: string;
  }) => Promise<{
    readonly exitCode: number;
    readonly stderr: string;
    readonly packageRoot: string;
  }>;
}

export interface PluginAddPrompter {
  readonly confirmTrust: (request: {
    readonly pluginName: string;
    readonly spec: string;
  }) => Promise<boolean>;
}

export type PluginTrustStore = Set<string>;

export const globalTrustStore: PluginTrustStore = new Set<string>();

export interface PluginAddOptions {
  readonly spec: string;
  readonly trust?: boolean;
  readonly nonInteractive?: boolean;
  readonly pluginsRoot?: string;
  readonly userDataRoot?: string;
  readonly cacheRoot?: string;
  readonly spawner?: PluginAddSpawner;
  readonly registryUrl?: string;
  readonly registryClient?: NpmRegistryClient;
  readonly fetcher?: TarballRecipeFetcher;
  readonly extractor?: TarballRecipeExtractor;
  readonly prompter?: PluginAddPrompter;
  readonly trustStore?: PluginTrustStore;
}

export interface PluginAddResult {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly pluginsRoot: string;
  readonly entry: string;
  readonly trusted: boolean;
  readonly trustSource: "flag" | "persistent" | "prompt" | "session" | "untrusted";
}

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*(@[^/\s]+)?$/i;

const trustNonInteractiveError = (spec: string): NotImplementedError =>
  new NotImplementedError({
    message: "Plugin trust prompt cannot run non-interactively without --trust.",
    commandId: "meta:plugin:add",
    remediation: `Re-run \`lando plugin:add ${spec} --trust\` to confirm the plugin should run as trusted host code. Persistent trust storage is deferred to Beta.`,
  });

const trustRejectedError = (pluginName: string): NotImplementedError =>
  new NotImplementedError({
    message: `User declined to trust plugin ${pluginName}.`,
    commandId: "meta:plugin:add",
    remediation: "Re-run with --trust if you intend to trust the plugin as host code.",
  });

const installFailure = (spec: string, stderr: string): NotImplementedError =>
  new NotImplementedError({
    message: `BunSelfExecError: bun add failed for ${spec}.`,
    commandId: "meta:plugin:add",
    remediation: `Resolve the underlying bun error and retry:\n${stderr.trim()}`,
  });

const ensurePluginsRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    await writeFile(
      pkgPath,
      `${JSON.stringify(
        { name: "lando-plugin-root", private: true, version: "0.0.0", description: "Managed by Lando." },
        null,
        2,
      )}\n`,
    );
  }
};

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const parsePackageName = (spec: string): string => {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const after = spec.slice(slash + 1);
    const at = after.indexOf("@");
    return at === -1 ? spec : `${spec.slice(0, slash + 1)}${after.slice(0, at)}`;
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
};

const decodePackageJson = (content: string, packageDir: string): PluginManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new PluginManifestError({
      message: `package.json in ${packageDir} is not valid JSON.`,
      issues: [(cause as Error).message],
    });
  }
  const candidate = (parsed as { landoPlugin?: unknown })?.landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate);
  if (Either.isLeft(decoded)) {
    const nameField = (parsed as { name?: unknown })?.name;
    const name = typeof nameField === "string" ? nameField : undefined;
    throw new PluginManifestError({
      message: `Plugin manifest validation failed${name === undefined ? "" : ` for ${name}`}.`,
      ...(name === undefined ? {} : { pluginName: name }),
      issues: [String(decoded.left)],
    });
  }
  return decoded.right;
};

const verifyContainment = async (manifest: PluginManifest, packageDir: string): Promise<string> => {
  const entryRel = manifest.entry ?? "index.js";
  const entryAbs = resolve(packageDir, entryRel);
  const rel = relative(packageDir, entryAbs);
  if (rel.startsWith("..") || resolve(packageDir, rel) !== entryAbs) {
    throw new PluginManifestError({
      message: `Plugin ${manifest.name} declares an entry path that escapes its package directory.`,
      pluginName: manifest.name,
      issues: [`entry ${entryRel} resolves outside ${packageDir}`],
    });
  }
  try {
    const realRoot = await realpath(packageDir);
    const realEntry = await realpath(entryAbs).catch(() => entryAbs);
    const realRel = relative(realRoot, realEntry);
    if (realRel.startsWith("..")) {
      throw new PluginManifestError({
        message: `Plugin ${manifest.name} entry resolves through symlink outside its package directory.`,
        pluginName: manifest.name,
        issues: [`realpath of entry escapes ${realRoot}`],
      });
    }
  } catch (cause) {
    if (cause instanceof PluginManifestError) throw cause;
  }
  return entryAbs;
};

export const validatePluginManifest = async (
  packageDir: string,
): Promise<{ readonly manifest: PluginManifest; readonly entry: string }> => {
  const content = await readFile(join(packageDir, "package.json"), "utf8");
  const manifest = decodePackageJson(content, packageDir);
  const entry = await verifyContainment(manifest, packageDir);
  return { manifest, entry };
};

const packageDeclaresPostinstall = async (packageDir: string): Promise<boolean> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return false;
  const postinstall = (scripts as Record<string, unknown>).postinstall;
  return typeof postinstall === "string" && postinstall.trim() !== "";
};

interface InstalledPluginPackage {
  readonly created: boolean;
  readonly packageDir: string;
}

const npmInstallFailure = (message: string, spec: string): NotImplementedError =>
  new NotImplementedError({
    message,
    commandId: "meta:plugin:add",
    remediation: `Check the npm package spec and registry metadata, then retry \`lando plugin:add ${spec}\`.`,
  });

const assertSafeInstallSegment = (value: string, label: string, spec: string): void => {
  const slashPath = value.replace(/\\/gu, "/");
  const segments = slashPath.split("/");
  if (
    value.trim() === "" ||
    isAbsolute(value) ||
    slashPath.startsWith("/") ||
    value.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw npmInstallFailure(`Resolved npm plugin ${label} escapes the plugin root: ${value}`, spec);
  }
};

const installTargetFor = (pluginsRoot: string, name: string, version: string, spec: string): string => {
  assertSafeInstallSegment(name, "name", spec);
  assertSafeInstallSegment(version, "version", spec);
  const packageDir = join(pluginsRoot, name, version);
  const rel = relative(pluginsRoot, packageDir);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw npmInstallFailure(`Resolved npm plugin install path escapes the plugin root: ${packageDir}`, spec);
  }
  return packageDir;
};

const installFromNpm = async (
  options: PluginAddOptions,
  pluginsRoot: string,
): Promise<InstalledPluginPackage> => {
  const parsed = parseNpmPackageSpec(options.spec);
  const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
  const client = options.registryClient ?? defaultNpmRegistryClient(registryUrl);
  let packument: NpmPackument | undefined;
  try {
    packument = await client.fetchPackument(parsed.name);
  } catch (cause) {
    throw npmInstallFailure(
      `Could not fetch npm metadata for "${parsed.name}" from ${registryUrl}: ${String(cause)}`,
      options.spec,
    );
  }
  if (packument === undefined) {
    throw npmInstallFailure(
      `npm package "${parsed.name}" was not found in the registry ${registryUrl}.`,
      options.spec,
    );
  }
  const resolvedVersion = resolveNpmPackageVersion(packument, parsed.version, options.spec);
  const dist = packument.versions?.[resolvedVersion]?.dist;
  if (dist === undefined || dist.tarball === undefined || dist.tarball.trim() === "") {
    throw npmInstallFailure(
      `npm package "${parsed.name}@${resolvedVersion}" has no published tarball URL.`,
      options.spec,
    );
  }

  const packageDir = installTargetFor(pluginsRoot, parsed.name, resolvedVersion, options.spec);
  if (await fileExists(packageDir)) return { created: false, packageDir };

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = await (options.fetcher ?? defaultTarballRecipeFetcher).fetch(dist.tarball);
  } catch (cause) {
    throw npmInstallFailure(`Could not download npm tarball ${dist.tarball}: ${String(cause)}`, options.spec);
  }
  verifyNpmPackageDistIntegrity(archiveBytes, dist, dist.tarball);

  const finalParent = dirname(packageDir);
  await mkdir(finalParent, { recursive: true });
  const stagingRoot = await mkdtemp(join(finalParent, ".staging-"));
  try {
    await (options.extractor ?? defaultTarballRecipeExtractor).extract(archiveBytes, stagingRoot);
    const extractedPackageDir = join(stagingRoot, "package");
    await validatePluginManifest(extractedPackageDir);
    await publish(extractedPackageDir, packageDir);
  } catch (cause) {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(packageDir, { recursive: true, force: true });
    throw cause;
  }
  await rm(stagingRoot, { recursive: true, force: true });
  return { created: true, packageDir };
};

const defaultPrompter: PluginAddPrompter = {
  confirmTrust: async ({ pluginName }) => {
    const io = createStdioPromptIO();
    if (!io.isTTY) return false;
    io.write(
      `Plugin ${pluginName} will run as TRUSTED HOST CODE.\nTrust this plugin for the current Lando session? [y/N] `,
    );
    const line = (await io.readLine()).trim().toLowerCase();
    return line === "y" || line === "yes";
  },
};

const ensureTrust = async (
  manifest: PluginManifest,
  packageDir: string,
  options: PluginAddOptions,
  persistentStore?: typeof PersistentPluginTrustStore.Service,
): Promise<"flag" | "persistent" | "prompt" | "session"> => {
  const store = options.trustStore ?? globalTrustStore;
  if (store.has(manifest.name)) return "session";
  if (
    persistentStore !== undefined &&
    ((await Effect.runPromise(persistentStore.isPluginTrusted(manifest.name))) ||
      (await Effect.runPromise(persistentStore.isAuthoringRootTrusted(resolve(packageDir)))))
  ) {
    store.add(manifest.name);
    return "persistent";
  }
  if (options.trust === true) {
    store.add(manifest.name);
    if (persistentStore !== undefined) await Effect.runPromise(persistentStore.trustPlugin(manifest.name));
    return "flag";
  }
  if (options.nonInteractive === true) {
    throw trustNonInteractiveError(options.spec);
  }
  const prompter = options.prompter ?? defaultPrompter;
  const ok = await prompter.confirmTrust({ pluginName: manifest.name, spec: options.spec });
  if (!ok) throw trustRejectedError(manifest.name);
  store.add(manifest.name);
  return "prompt";
};

export const pluginAdd = (
  options: PluginAddOptions,
): Effect.Effect<
  PluginAddResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | RecipeSourceError,
  ConfigService | PersistentPluginTrustStore
> =>
  Effect.gen(function* () {
    if (typeof options.spec !== "string" || options.spec.trim().length === 0) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: "Plugin spec is required.",
          commandId: "meta:plugin:add",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      );
    }
    if (!REGISTRY_NAME_RE.test(options.spec)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:plugin:add only supports npm registry specs in Alpha (got ${options.spec}).`,
          commandId: "meta:plugin:add",
          remediation:
            "Git URL, tarball, and file: source kinds land in Beta. Pass a registry spec like `@lando/plugin-php@1.0.0`.",
        }),
      );
    }

    let pluginsRoot = options.pluginsRoot;
    if (pluginsRoot === undefined) {
      let userDataRoot = options.userDataRoot;
      if (userDataRoot === undefined) {
        const configService = yield* ConfigService;
        userDataRoot = yield* configService.get("userDataRoot");
        if (userDataRoot === undefined) {
          return yield* Effect.fail(
            new NotImplementedError({
              message: "userDataRoot is not configured.",
              commandId: "meta:plugin:add",
              remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
            }),
          );
        }
      }
      pluginsRoot = join(userDataRoot, "plugins");
    }
    yield* Effect.promise(() => ensurePluginsRoot(pluginsRoot));

    const packageName = parsePackageName(options.spec);
    let createdPackageDir: string | undefined;
    const packageDir = yield* Effect.tryPromise({
      try: async () => {
        if (options.spawner !== undefined) {
          const installed = await options.spawner.install({ spec: options.spec, cwd: pluginsRoot });
          if (installed.exitCode !== 0) throw installFailure(options.spec, installed.stderr);
          return installed.packageRoot ?? join(pluginsRoot, "node_modules", packageName);
        }
        const installed = await installFromNpm(options, pluginsRoot);
        if (installed.created) createdPackageDir = installed.packageDir;
        return installed.packageDir;
      },
      catch: (cause) =>
        cause instanceof RecipeSourceError
          ? npmInstallFailure(cause.message, options.spec)
          : cause instanceof NotImplementedError || cause instanceof PluginManifestError
            ? cause
            : new NotImplementedError({
                message: `Plugin install failed for ${options.spec}: ${String(cause)}`,
                commandId: "meta:plugin:add",
                remediation: "Check the plugin package and retry.",
              }),
    });

    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(packageDir),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Failed to validate plugin manifest: ${String(cause)}`,
              issues: [String(cause)],
            }),
    });

    const hasPostinstall = yield* Effect.promise(() => packageDeclaresPostinstall(packageDir));
    const persistentStoreOption = yield* Effect.serviceOption(PersistentPluginTrustStore);
    const persistentStore = persistentStoreOption._tag === "Some" ? persistentStoreOption.value : undefined;

    const trustStoreForRollback = options.trustStore ?? globalTrustStore;
    const hadTrustBefore = trustStoreForRollback.has(manifest.name);
    const trustSource = yield* Effect.tryPromise({
      try: async () => {
        if (hasPostinstall && options.trust !== true) {
          if (trustStoreForRollback.has(manifest.name)) return "session";
          if (
            persistentStore !== undefined &&
            ((await Effect.runPromise(persistentStore.isPluginTrusted(manifest.name))) ||
              (await Effect.runPromise(persistentStore.isAuthoringRootTrusted(resolve(packageDir)))))
          ) {
            trustStoreForRollback.add(manifest.name);
            return "persistent";
          }
          return "untrusted";
        }
        return ensureTrust(manifest, packageDir, options, persistentStore);
      },
      catch: (cause) =>
        cause instanceof NotImplementedError
          ? cause
          : new NotImplementedError({
              message: `Unexpected trust failure: ${String(cause)}`,
              commandId: "meta:plugin:add",
              remediation: "Re-run with --trust to bypass the prompt.",
            }),
    });

    yield* Effect.promise(async () => {
      try {
        await recordInstalledPlugin(pluginsRoot, {
          name: manifest.name,
          version: manifest.version,
          path: packageDir,
        });
      } catch (cause) {
        if (createdPackageDir !== undefined) await rm(createdPackageDir, { recursive: true, force: true });
        if (!hadTrustBefore && trustSource !== "session" && trustSource !== "untrusted") {
          trustStoreForRollback.delete(manifest.name);
        }
        throw cause;
      }
    });

    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });

    return {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      pluginsRoot,
      entry: packageDir,
      trusted: trustSource !== "untrusted",
      trustSource,
    };
  });

export const renderPluginAddResult = (result: PluginAddResult): string =>
  `installed: ${result.pluginName}@${result.pluginVersion}\ntrusted: ${result.trustSource}\nplugins-root: ${result.pluginsRoot}${
    result.trusted
      ? ""
      : `\nremediation: run \`lando meta:plugin:trust ${result.pluginName}\` to allow the plugin postinstall path.`
  }`;
