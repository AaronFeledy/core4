import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { resolveLandoRoots } from "@lando/paths";
import { deepMerge, envOverlay, resolveConfigFileRoot, rootEnvOverlay } from "@lando/paths/overlay";
import { MinimalYamlError, parseMinimalYaml } from "@lando/paths/yaml-min";
import { resolveUserConfRoot } from "../config/roots.ts";

const NETWORK_BOOLEAN_ENV_ALIASES = [
  "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
  "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
] as const;

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
    const malformedAlias = NETWORK_BOOLEAN_ENV_ALIASES.find((name) => {
      const value = process.env[name];
      return value !== undefined && value !== "true" && value !== "false";
    });
    if (malformedAlias !== undefined) {
      throw configError(
        path,
        `Invalid ${malformedAlias} value. Expected "true" or "false"; set it to one of those values or unset it.`,
        cause,
      );
    }
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
