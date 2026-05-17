import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

const DEFAULT_CONFIG_ROOT = `${process.env.HOME ?? "."}/.lando`;
const DEFAULT_DATA_ROOT = `${process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? "."}/.local/share`}/lando`;

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

const booleanEnv = (value: string): boolean => value === "1" || value.toLowerCase() === "true";

const envOverlay = (): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  if (process.env.LANDO_USER_DATA_ROOT !== undefined) overlay.userDataRoot = process.env.LANDO_USER_DATA_ROOT;
  if (process.env.LANDO_USER_CONF_ROOT !== undefined) overlay.userConfRoot = process.env.LANDO_USER_CONF_ROOT;
  if (process.env.LANDO_DEFAULT_PROVIDER_ID !== undefined) {
    overlay.defaultProviderId =
      process.env.LANDO_DEFAULT_PROVIDER_ID === "" ? null : process.env.LANDO_DEFAULT_PROVIDER_ID;
  }
  if (process.env.LANDO_TELEMETRY_ENABLED !== undefined) {
    overlay.telemetry = { enabled: booleanEnv(process.env.LANDO_TELEMETRY_ENABLED) };
  }
  return overlay;
};

const mergeConfig = (fileConfig: Record<string, unknown>, overlay: Record<string, unknown>): unknown => ({
  userDataRoot: DEFAULT_DATA_ROOT,
  defaultProviderId: "lando",
  ...fileConfig,
  ...overlay,
  telemetry: {
    ...((typeof fileConfig.telemetry === "object" && fileConfig.telemetry !== null
      ? fileConfig.telemetry
      : {}) as Record<string, unknown>),
    ...((typeof overlay.telemetry === "object" && overlay.telemetry !== null
      ? overlay.telemetry
      : {}) as Record<string, unknown>),
  },
});

const loadConfig = async (): Promise<GlobalConfig> => {
  const userConfRoot = process.env.LANDO_USER_CONF_ROOT ?? DEFAULT_CONFIG_ROOT;
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
