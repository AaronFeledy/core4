import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  GlobalConfig,
  GlobalConfigView,
  formatValidationIssueLine,
  formatValidationIssuePath,
  hostEventsConfigIssues,
  suggestionForUnknownKey,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";
import { DateTime, Option } from "effect";

import { resolveLandoRoots } from "@lando/paths";
import { deepMerge, envOverlay, resolveConfigFileRoot, rootEnvOverlay } from "@lando/paths/overlay";
import { MinimalYamlError, parseMinimalYaml } from "@lando/paths/yaml-min";
import { getAtPath } from "../config-write/dot-path";
import { resolveUserConfRoot } from "../config/roots.ts";

const NETWORK_BOOLEAN_ENV_ALIASES = [
  "LANDO_NETWORK_CA_INJECT_INTO_SERVICES",
  "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES",
] as const;

const KNOWN_GLOBAL_CONFIG_KEYS = Object.keys(GlobalConfig.fields);
const PATH_LIKE_ROOT_KEYS = new Set(["userDataRoot", "userConfRoot", "userCacheRoot", "systemPluginRoot"]);

export const typoWarningsFromFileConfig = (fileConfig: Record<string, unknown>): ReadonlyArray<string> =>
  Object.keys(fileConfig).flatMap((key) => {
    if (KNOWN_GLOBAL_CONFIG_KEYS.includes(key)) return [];
    const suggestion = suggestionForUnknownKey(key, KNOWN_GLOBAL_CONFIG_KEYS);
    return suggestion === undefined ? [] : [`Unknown config.yml key "${key}". ${suggestion}`];
  });

const hasControlCharacters = (value: string): boolean => {
  for (const char of value) {
    if (char.charCodeAt(0) < 32) return true;
  }
  return false;
};

const pathEscapeWarningsFromFileConfig = (fileConfig: Record<string, unknown>): ReadonlyArray<string> =>
  Object.entries(fileConfig).flatMap(([key, value]) => {
    if (typeof value !== "string" || !hasControlCharacters(value)) return [];
    const pathLike = PATH_LIKE_ROOT_KEYS.has(key) || /^[A-Za-z]:/.test(value);
    if (!pathLike) return [];
    return [
      `config.yml ${key} decoded with control characters. Double-quoted YAML treats \\t and \\n as escapes. Use single quotes or \\\\.`,
    ];
  });

const typoWarningsByConfig = new WeakMap<GlobalConfig, ReadonlyArray<string>>();

export const typoWarningsForConfig = (config: GlobalConfig): ReadonlyArray<string> =>
  typoWarningsByConfig.get(config) ?? [];

export const validateFileHostEvents = (fileConfig: Record<string, unknown>, path: string): void => {
  if (!Object.hasOwn(fileConfig, "hostEvents")) return;
  const issues = hostEventsConfigIssues(fileConfig.hostEvents);
  if (issues[0] === undefined) return;
  throw new ConfigError({
    path,
    message: issues[0].message,
    issues,
    remediation: "Edit hostEvents in config.yml directly or use `lando config edit`.",
  });
};

const configError = (path: string, message: string, cause?: unknown): ConfigError =>
  new ConfigError({ message, path, ...(cause === undefined ? {} : { cause }) });

// Shared with the Effect-free `resolveUserDataRoot` (`config/roots.ts`) so both
// interpret `config.yml` identically; map its plain failures onto `ConfigError`.
const parseConfigYaml = (text: string, path: string): Record<string, unknown> => {
  try {
    return parseMinimalYaml(text);
  } catch (cause) {
    if (cause instanceof MinimalYamlError) {
      throw new ConfigError({
        path,
        message: `Invalid YAML in config file ${path}: ${cause.message}`,
        remediation: "Fix the YAML syntax with `lando config edit` or edit config.yml directly.",
      });
    }
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

  validateFileHostEvents(fileConfig, path);
  const warnings = [
    ...typoWarningsFromFileConfig(fileConfig),
    ...pathEscapeWarningsFromFileConfig(fileConfig),
  ];

  const merged = mergeConfig(fileConfig, overlay);
  try {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)(merged, { errors: "all" });
    typoWarningsByConfig.set(decoded, warnings);
    return decoded;
  } catch (cause) {
    throw globalConfigDecodeError(path, cause, deepMerge(rootEnvOverlay(), overlay));
  }
};

const FILE_REPAIR_REMEDIATION =
  "Run `lando config validate` for file issues, then use `lando config set <key> <value>` / `lando config unset <key>`, or `lando config edit` to repair config.yml.";

// `lando config validate` decodes only config.yml, so an issue whose value an
// env override supplies must point the user at that override instead.
const globalConfigDecodeError = (
  path: string,
  cause: unknown,
  environment: Record<string, unknown>,
): ConfigError => {
  const issues = validationIssuesFromCause(cause);
  const first = issues[0];
  const detail = `${first === undefined ? "Invalid value." : formatValidationIssueLine(first)}${
    issues.length > 1 ? ` (and ${issues.length - 1} more issues)` : ""
  }`;
  const envPaths = issues
    .map((issue) => formatValidationIssuePath(issue.path))
    .filter((issuePath) => getAtPath(environment, issuePath) !== undefined);
  if (envPaths.length === 0) {
    return new ConfigError({
      path,
      message: `Invalid config file ${path}: ${detail}`,
      issues,
      remediation: FILE_REPAIR_REMEDIATION,
    });
  }

  const fileIssuesToo = envPaths.length < issues.length;
  const malformedAlias = NETWORK_BOOLEAN_ENV_ALIASES.find((name) => {
    const value = process.env[name];
    return value !== undefined && value !== "true" && value !== "false";
  });
  const sources = `${fileIssuesToo ? "config file and " : ""}environment override${
    malformedAlias === undefined ? "" : ` ${malformedAlias}`
  }`;
  const remediation = [
    `Unset or fix the environment override for ${envPaths.join(", ")}.`,
    ...(malformedAlias === undefined ? [] : [`Set ${malformedAlias} to "true" or "false", or unset it.`]),
    "`lando config validate` checks only the file tree.",
    ...(fileIssuesToo ? [FILE_REPAIR_REMEDIATION] : []),
  ].join(" ");
  return new ConfigError({
    path,
    message: `Invalid global configuration (${sources}): ${detail}`,
    issues,
    remediation,
  });
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
      for (const body of typoWarningsForConfig(loaded)) {
        yield* events.value
          .publish(MessageWarnEvent.make({ body, timestamp: DateTime.nowUnsafe() }))
          .pipe(Effect.ignore);
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
