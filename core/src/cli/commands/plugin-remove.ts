import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Effect } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*$/i;

export interface PluginRemoveSpawner {
  readonly uninstall: (request: {
    readonly name: string;
    readonly cwd: string;
  }) => Promise<{ readonly exitCode: number; readonly stderr: string }>;
}

export interface PluginRemoveOptions {
  readonly name: string;
  readonly userDataRoot?: string;
  readonly pluginsRoot?: string;
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
    specSection: "spec/10-plugins.md",
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
          specSection: "spec/10-plugins.md",
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
            specSection: "spec/10-plugins.md",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const pluginsRoot = join(userDataRoot, "plugins");
    const modulesRoot = resolve(pluginsRoot, "node_modules");
    const moduleDir = resolve(modulesRoot, options.name);
    const rel = relative(modulesRoot, moduleDir);
    if (rel === "" || rel.startsWith("..") || resolve(modulesRoot, rel) !== moduleDir) {
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Plugin name resolves outside ${modulesRoot}.`,
          ...(options.name === "" ? {} : { pluginName: options.name }),
          issues: [`refusing to recursively remove ${moduleDir}`],
        }),
      );
    }
    if (!existsSync(moduleDir)) {
      return { pluginName: options.name, removed: false };
    }

    const spawner = options.spawner ?? defaultSpawner;
    const { exitCode, stderr } = yield* Effect.promise(() =>
      spawner.uninstall({ name: options.name, cwd: pluginsRoot }),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(removeFailure(options.name, stderr));
    }
    yield* Effect.promise(() => rm(moduleDir, { recursive: true, force: true }));
    const trustStore = options.trustStore;
    if (trustStore !== undefined) trustStore.delete(options.name);
    return { pluginName: options.name, removed: true };
  });

export const renderPluginRemoveResult = (result: PluginRemoveResult): string =>
  result.removed ? `removed: ${result.pluginName}` : `not-installed: ${result.pluginName} (no-op)`;
