import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Context, Effect, Layer, Result, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { DateTime, Option } from "effect";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  GlobalConfig,
  GlobalConfigView,
  HostEvents,
  hostEventsSemanticIssues,
  suggestionForUnknownKey,
} from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";
import { validationIssuesFromCause } from "@lando/sdk/schema";

import { resolveLandoRoots } from "@lando/paths";
import { deepMerge, envOverlay, resolveConfigFileRoot, rootEnvOverlay } from "@lando/paths/overlay";
import { MinimalYamlError, parseMinimalYaml } from "@lando/paths/yaml-min";
import { resolveUserConfRoot } from "../config/roots.ts";

const NETWORK_BOOLEAN_ENV_ALIASES = [
  "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
  "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
] as const;

const KNOWN_GLOBAL_CONFIG_KEYS = Object.keys(GlobalConfig.fields);

let typoWarnings: ReadonlyArray<string> = [];

export const takeGlobalConfigTypoWarnings = (): ReadonlyArray<string> => {
  const warnings = typoWarnings;
  typoWarnings = [];
  return warnings;
};

const collectTypoWarnings = (fileConfig: Record<string, unknown>): void => {
  typoWarnings = Object.keys(fileConfig).flatMap((key) => {
    if (KNOWN_GLOBAL_CONFIG_KEYS.includes(key)) return [];
    const suggestion = suggestionForUnknownKey(key, KNOWN_GLOBAL_CONFIG_KEYS);
    return suggestion === undefined ? [] : [`Unknown config.yml key "${key}". ${suggestion}`];
  });
};

const HostEventsFile = Schema.Struct({ hostEvents: HostEvents });

const validateFileHostEvents = (fileConfig: Record<string, unknown>, path: string): void => {
  if (!Object.hasOwn(fileConfig, "hostEvents")) return;
  const decoded = Schema.decodeUnknownResult(HostEventsFile)({ hostEvents: fileConfig.hostEvents }, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Result.isFailure(decoded)) {
    const issues = validationIssuesFromCause(decoded.failure, { fallback: "Invalid hostEvents." });
    throw configError(path, issues[0]?.message ?? "Invalid hostEvents.", decoded.failure);
  }
  const semantic = hostEventsSemanticIssues(decoded.success.hostEvents);
  if (semantic[0] !== undefined) throw configError(path, semantic[0].message, { issues: semantic });
};

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
  const merged = deepMerge(deepMerge(deepMerge(base, fileConfig), rootEnvOverlay()), overlay);
  for (const key of ["appEnv", "appLabels"] as const) {
    if (Object.hasOwn(overlay, key)) merged[key] = overlay[key];
  }
  return merged;
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

  collectTypoWarnings(fileConfig);
  validateFileHostEvents(fileConfig, path);

  const merged = mergeConfig(fileConfig, overlay);
  try {
    return Schema.decodeUnknownSync(GlobalConfig)(merged, { errors: "all" });
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

const configService: Context.Service.Shape<typeof ConfigService> = ConfigService.of({
  load: Effect.gen(function* () {
    const loaded = yield* Effect.try({
      try: () => loadGlobalConfigSync(),
      catch: (cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({ message: "Failed to load global config.", cause }),
    });
    const events = yield* Effect.serviceOption(EventService);
    if (Option.isSome(events)) {
      for (const body of takeGlobalConfigTypoWarnings()) {
        yield* events.value.publish(MessageWarnEvent.make({ body, timestamp: DateTime.nowUnsafe() }));
      }
    }
    return loaded;
  }),
  get: (key) => Effect.map(configService.load, (config) => config[key]),
});

export const layer = Layer.succeed(ConfigService, configService);

export const loadGlobalConfigView = Effect.gen(function* () {
  const service = yield* ConfigService;
  const loaded = yield* service.load;
  return yield* Schema.encodeEffect(GlobalConfigView)(loaded).pipe(
    Effect.mapError((cause) => configError("", "Failed to project public global config.", cause)),
  );
});
