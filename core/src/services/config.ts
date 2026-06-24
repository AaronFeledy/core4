import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { deepMerge, envOverlay, resolveConfigFileRoot, rootEnvOverlay } from "../config/overlay.ts";
import { resolveLandoRoots } from "../config/paths.ts";
import { resolveUserConfRoot } from "../config/roots.ts";
import { MinimalYamlError, parseMinimalYaml } from "../config/yaml-min.ts";

const configError = (path: string, message: string, cause?: unknown): ConfigError =>
  new ConfigError({ message, path, ...(cause === undefined ? {} : { cause }) });

// Shared with the Effect-free `resolveUserDataRoot` (`config/roots.ts`) so both
// interpret `config.yml` identically; map its plain failures onto `ConfigError`.
const parseConfigYaml = (text: string, path: string): Record<string, unknown> => {
  try {
    return parseMinimalYaml(text);
  } catch (cause) {
    if (cause instanceof MinimalYamlError) throw configError(path, cause.message);
    throw cause;
  }
};

const mergeConfig = (fileConfig: Record<string, unknown>, overlay: Record<string, unknown>): unknown => {
  const roots = resolveLandoRoots();
  const base: Record<string, unknown> = {
    userDataRoot: roots.userDataRoot,
    userConfRoot: roots.userConfRoot,
    userCacheRoot: roots.userCacheRoot,
    systemPluginRoot: roots.systemPluginRoot,
    defaultProviderId: "lando",
  };
  return deepMerge(deepMerge(deepMerge(base, fileConfig), rootEnvOverlay()), overlay);
};

export const loadGlobalConfigSync = (): GlobalConfig => {
  const overlay = envOverlay();
  const userConfRoot = resolveConfigFileRoot(resolveUserConfRoot(), overlay);
  const path = join(userConfRoot, "config.yml");
  let fileConfig: Record<string, unknown> = {};

  if (existsSync(path)) {
    try {
      fileConfig = parseConfigYaml(readFileSync(path, "utf8"), path);
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      throw configError(path, `Failed to parse config file: ${path}`, cause);
    }
  }

  const merged = mergeConfig(fileConfig, overlay);
  try {
    return Schema.decodeUnknownSync(GlobalConfig)(merged);
  } catch (cause) {
    throw configError(path, `Invalid config file: ${path}`, cause);
  }
};

const loadConfig = async (): Promise<GlobalConfig> => loadGlobalConfigSync();

const configService: Context.Tag.Service<typeof ConfigService> = {
  load: Effect.tryPromise({
    try: loadConfig,
    catch: (cause) =>
      cause instanceof ConfigError
        ? cause
        : new ConfigError({ message: "Failed to load global config.", cause }),
  }),
  get: (key) => Effect.map(configService.load, (config) => config[key]),
};

export const ConfigServiceLive = Layer.succeed(ConfigService, configService);
