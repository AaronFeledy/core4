import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { resolveUserConfRoot, resolveUserDataRoot } from "../config/roots.ts";

const configError = (path: string, message: string, cause?: unknown): ConfigError =>
  new ConfigError({ message, path, ...(cause === undefined ? {} : { cause }) });

const parseScalar = (value: string, path: string): unknown => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    throw configError(path, `Unsupported YAML value: ${trimmed}`);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseConfigYaml = (text: string, path: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    const trimmedLine = withoutComment.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const match = trimmedLine.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (match === null) {
      throw configError(path, `Malformed YAML at line ${index + 1}`);
    }

    let current = stack.at(-1);
    while (stack.length > 1 && current !== undefined && indent <= current.indent) {
      stack.pop();
      current = stack.at(-1);
    }

    const parent = stack.at(-1);
    if (parent === undefined) {
      throw configError(path, `Malformed YAML at line ${index + 1}`);
    }
    if (indent <= parent.indent) {
      throw configError(path, `Malformed YAML indentation at line ${index + 1}`);
    }

    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined) {
      throw configError(path, `Malformed YAML at line ${index + 1}`);
    }

    if (rawValue.trim() === "") {
      const nested: Record<string, unknown> = {};
      parent.value[key] = nested;
      stack.push({ indent, value: nested });
      continue;
    }

    parent.value[key] = parseScalar(rawValue, path);
  }

  return root;
};

const ENV_OVERLAY_PREFIX = "LANDO_CONFIG__";

// `default_provider_id` / `DEFAULT_PROVIDER_ID` -> camelCase key `defaultProviderId`.
const segmentToKey = (segment: string): string =>
  segment.toLowerCase().replace(/_+([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

// JSON-parseable values become objects/arrays/numbers/booleans/null; anything
// else (e.g. a bare `podman`) is kept verbatim as a string.
const isTelemetryEnabledPath = (path: ReadonlyArray<string>): boolean =>
  path.length === 2 && path[0] === "telemetry" && path[1] === "enabled";

const parseTelemetryEnabledOverlay = (raw: string): boolean => raw === "1" || raw.toLowerCase() === "true";

const parseOverlayValue = (raw: string, path: ReadonlyArray<string>): unknown => {
  if (raw === "" && path.length === 1 && path[0] === "defaultProviderId") return null;
  if (isTelemetryEnabledPath(path)) return parseTelemetryEnabledOverlay(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assignDeep = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const existing = cursor[key];
    if (!isPlainObject(existing)) {
      const nested: Record<string, unknown> = {};
      cursor[key] = nested;
      cursor = nested;
    } else {
      cursor = existing;
    }
  }
  cursor[path[path.length - 1] as string] = value;
};

const deepMerge = (
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
};

/**
 * Generic `LANDO_CONFIG__path__to__value` overlay: a single delimiter-driven
 * mechanism that can target any config path, replacing the earlier set of
 * single-purpose env vars.
 */
const envOverlay = (env: Record<string, string | undefined> = process.env): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(ENV_OVERLAY_PREFIX)) continue;
    const rawPath = name.slice(ENV_OVERLAY_PREFIX.length);
    const segments = rawPath.split("__").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    const path = segments.map(segmentToKey);
    assignDeep(overlay, path, parseOverlayValue(value, path));
  }
  return overlay;
};

const rootEnvOverlay = (env: Record<string, string | undefined> = process.env): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  if (env.LANDO_USER_DATA_ROOT !== undefined) overlay.userDataRoot = env.LANDO_USER_DATA_ROOT;
  if (env.LANDO_USER_CONF_ROOT !== undefined) overlay.userConfRoot = env.LANDO_USER_CONF_ROOT;
  return overlay;
};

const mergeConfig = (fileConfig: Record<string, unknown>, overlay: Record<string, unknown>): unknown => {
  const base: Record<string, unknown> = {
    userDataRoot: resolveUserDataRoot(),
    userConfRoot: resolveUserConfRoot(),
    defaultProviderId: "lando",
  };
  return deepMerge(deepMerge(deepMerge(base, fileConfig), rootEnvOverlay()), overlay);
};

const loadConfig = async (): Promise<GlobalConfig> => {
  const userConfRoot = resolveUserConfRoot();
  const path = join(userConfRoot, "config.yml");
  const file = Bun.file(path);
  let fileConfig: Record<string, unknown> = {};

  if (await file.exists()) {
    try {
      fileConfig = parseConfigYaml(await file.text(), path);
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      throw configError(path, `Failed to parse config file: ${path}`, cause);
    }
  }

  const merged = mergeConfig(fileConfig, envOverlay());
  try {
    return Schema.decodeUnknownSync(GlobalConfig)(merged);
  } catch (cause) {
    throw configError(path, `Invalid config file: ${path}`, cause);
  }
};

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
