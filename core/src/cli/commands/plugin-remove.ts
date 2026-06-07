import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { Effect } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "../../cache/command-index-writer.ts";
import { findLandofilePath } from "../../landofile/discovery.ts";
import { removeInstalledPlugin } from "../../plugins/installed-registry.ts";
import { parseNpmPackageSpec } from "../../recipes/npm-source.ts";

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*$/i;
const RESERVED_PLUGIN_ROOT_NAMES = new Set([
  "node_modules",
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "registry.json",
]);

export interface PluginRemoveSpawner {
  readonly uninstall: (request: {
    readonly name: string;
    readonly cwd: string;
  }) => Promise<{ readonly exitCode: number; readonly stderr: string }>;
}

export interface PluginRemoveOptions {
  readonly name: string;
  readonly userDataRoot?: string;
  readonly cacheRoot?: string;
  readonly pluginsRoot?: string;
  readonly cwd?: string;
  readonly spawner?: PluginRemoveSpawner;
  readonly trustStore?: Set<string>;
}

export interface PluginRemoveResult {
  readonly pluginName: string;
  readonly removed: boolean;
}

const removeFailure = (name: string, stderr: string): NotImplementedError =>
  new NotImplementedError({
    message: `BunSelfExecError: bun remove failed for ${name}.`,
    commandId: "meta:plugin:remove",
    remediation: `Resolve the underlying bun error and retry:\n${stderr.trim()}`,
  });

const defaultSpawner: PluginRemoveSpawner = {
  uninstall: async ({ name, cwd }) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "remove", name],
      cwd,
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>),
        BUN_BE_BUN: "1",
        LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exitCode, stderr };
  },
};

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const managedRootManifestError = (manifestPath: string, cause: unknown): NotImplementedError =>
  new NotImplementedError({
    message: `Managed plugin root package.json is not readable JSON: ${manifestPath}.`,
    commandId: "meta:plugin:remove",
    remediation: `Repair or remove ${manifestPath}, then retry plugin removal. Cause: ${String(cause)}`,
  });

const updateManagedRootManifest = async (pluginsRoot: string, name: string): Promise<void> => {
  const manifestPath = join(pluginsRoot, "package.json");
  if (!existsSync(manifestPath)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw managedRootManifestError(manifestPath, cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw managedRootManifestError(manifestPath, "manifest root is not an object");
  }

  let changed = false;
  const manifest = parsed as Record<string, unknown>;
  for (const field of dependencyFields) {
    const deps = manifest[field];
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) continue;
    const depRecord = deps as Record<string, unknown>;
    if (Object.hasOwn(depRecord, name)) {
      delete depRecord[name];
      changed = true;
    }
  }
  if (!changed) return;

  const tmpPath = `${manifestPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(tmpPath, manifestPath);
};

const stripInlineComment = (line: string): string => line.replace(/\s+#.*$/u, "");

const pluginReferenceTokens = (value: string): ReadonlyArray<string> => {
  const tokens: string[] = [];
  let current = "";
  for (const char of value) {
    if (
      /\s/u.test(char) ||
      char === "," ||
      char === "[" ||
      char === "]" ||
      char === "{" ||
      char === "}" ||
      char === ":" ||
      char === "'" ||
      char === '"'
    ) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

const pluginReferenceMatches = (token: string, name: string): boolean => {
  if (token === name) return true;
  try {
    return parseNpmPackageSpec(token).name === name;
  } catch {
    return false;
  }
};

const pluginReferenceListIncludes = (value: string, name: string): boolean =>
  pluginReferenceTokens(value).some((token) => pluginReferenceMatches(token, name));

const landofileReferencesPlugin = (content: string, name: string): boolean => {
  const lines = content.split(/\r?\n/u);
  let inPluginsBlock = false;
  let pluginsIndent = 0;
  for (const rawLine of lines) {
    const withoutComment = stripInlineComment(rawLine);
    if (withoutComment.trim() === "") continue;
    const indent = withoutComment.match(/^ */u)?.[0].length ?? 0;
    const text = withoutComment.trim();
    if (inPluginsBlock && indent <= pluginsIndent) inPluginsBlock = false;
    if (!inPluginsBlock && indent === 0 && text.startsWith("plugins:")) {
      const inlineValue = text.slice("plugins:".length).trim();
      if (inlineValue !== "" && pluginReferenceListIncludes(inlineValue, name)) return true;
      inPluginsBlock = true;
      pluginsIndent = indent;
      continue;
    }
    if (inPluginsBlock && pluginReferenceListIncludes(text, name)) return true;
  }
  return false;
};

const activeLandofileRefusal = async (
  name: string,
  cwd: string,
): Promise<NotImplementedError | undefined> => {
  const landofilePath = await findLandofilePath(cwd);
  if (landofilePath === undefined) return undefined;
  const content = await readFile(landofilePath, "utf8");
  if (!landofileReferencesPlugin(content, name)) return undefined;
  const appName =
    content.match(/^name:\s*['"]?([^'"#\n]+)['"]?/mu)?.[1]?.trim() ?? basename(dirname(landofilePath));
  return new NotImplementedError({
    message: `Plugin ${name} is referenced by active Landofile ${landofilePath}.`,
    commandId: "meta:plugin:remove",
    remediation: `Remove ${name} from the plugins: block in app ${appName} (${landofilePath}), then retry \`lando plugin:remove ${name}\`.`,
  });
};

export const pluginRemove = (
  options: PluginRemoveOptions,
): Effect.Effect<
  PluginRemoveResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError,
  ConfigService
> =>
  Effect.gen(function* () {
    if (options.name === "") {
      return yield* Effect.fail(
        new NotImplementedError({
          message: "Plugin name is required.",
          commandId: "meta:plugin:remove",
          remediation: "Pass the plugin name, e.g. `lando plugin:remove @lando/plugin-php`.",
        }),
      );
    }
    if (!REGISTRY_NAME_RE.test(options.name)) {
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Invalid plugin name: ${options.name}`,
          issues: [
            "Plugin name must match the npm package-name grammar (`@scope/name` or `name`); path segments and version specifiers are rejected.",
          ],
        }),
      );
    }

    let userDataRoot = options.userDataRoot;
    if (userDataRoot === undefined) {
      const configService = yield* ConfigService;
      userDataRoot = yield* configService.get("userDataRoot");
      if (userDataRoot === undefined) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "userDataRoot is not configured.",
            commandId: "meta:plugin:remove",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const pluginsRoot = options.pluginsRoot ?? join(userDataRoot, "plugins");
    const modulesRoot = resolve(pluginsRoot, "node_modules");
    const moduleDir = resolve(modulesRoot, options.name);
    const moduleRel = relative(modulesRoot, moduleDir);
    if (moduleRel === "" || moduleRel.startsWith("..") || resolve(modulesRoot, moduleRel) !== moduleDir) {
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Plugin name resolves outside ${modulesRoot}.`,
          pluginName: options.name,
          issues: [`refusing to recursively remove ${moduleDir}`],
        }),
      );
    }
    const versionedDir = resolve(pluginsRoot, options.name);
    const versionedRel = relative(pluginsRoot, versionedDir);
    if (
      versionedRel === "" ||
      versionedRel.startsWith("..") ||
      resolve(pluginsRoot, versionedRel) !== versionedDir
    ) {
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Plugin name resolves outside ${pluginsRoot}.`,
          pluginName: options.name,
          issues: [`refusing to recursively remove ${versionedDir}`],
        }),
      );
    }
    if (RESERVED_PLUGIN_ROOT_NAMES.has(options.name)) {
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Plugin name "${options.name}" is reserved; refusing to remove shared/managed plugins root entries.`,
          pluginName: options.name,
          issues: [`refusing to recursively remove managed plugins root entry ${versionedDir}`],
        }),
      );
    }

    const activeRefusal = yield* Effect.promise(() =>
      activeLandofileRefusal(options.name, options.cwd ?? process.cwd()),
    );
    if (activeRefusal !== undefined) return yield* Effect.fail(activeRefusal);

    const hasModuleDir = existsSync(moduleDir);
    const hasVersionedDir = existsSync(versionedDir);
    if (!hasModuleDir && !hasVersionedDir) {
      yield* Effect.promise(() => removeInstalledPlugin(pluginsRoot, options.name));
      yield* invalidatePluginCommandCache({
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      });
      return { pluginName: options.name, removed: false };
    }

    if (hasModuleDir) {
      const spawner = options.spawner ?? defaultSpawner;
      const { exitCode, stderr } = yield* Effect.promise(() =>
        spawner.uninstall({ name: options.name, cwd: pluginsRoot }),
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(removeFailure(options.name, stderr));
      }
      yield* Effect.tryPromise({
        try: () => updateManagedRootManifest(pluginsRoot, options.name),
        catch: (cause) =>
          cause instanceof NotImplementedError
            ? cause
            : new NotImplementedError({
                message: `Failed to update managed plugin root package.json: ${String(cause)}`,
                commandId: "meta:plugin:remove",
                remediation: "Repair the managed plugin root package.json, then retry plugin removal.",
              }),
      });
      yield* Effect.promise(() => rm(moduleDir, { recursive: true, force: true }));
    }
    if (hasVersionedDir) {
      yield* Effect.promise(() => rm(versionedDir, { recursive: true, force: true }));
    }

    yield* Effect.promise(() => removeInstalledPlugin(pluginsRoot, options.name));

    const trustStore = options.trustStore;
    if (trustStore !== undefined) trustStore.delete(options.name);
    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return { pluginName: options.name, removed: true };
  });

export const renderPluginRemoveResult = (result: PluginRemoveResult): string =>
  result.removed ? `removed: ${result.pluginName}` : `not-installed: ${result.pluginName} (no-op)`;
