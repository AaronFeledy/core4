import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { ConfigError, type LandoCommandError, NotImplementedError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { envOverlay, resolveConfigFileRoot } from "../../config/overlay.ts";
import { resolveUserConfRoot } from "../../config/roots.ts";
import { parseMinimalYaml } from "../../config/yaml-min.ts";
import { emitLandofileYaml } from "../../landofile/yaml-emit.ts";
import { type CliTelemetrySource, resolveCliTelemetryState } from "../../runtime/cli-options.ts";
import { TELEMETRY_RETENTION_POLICY_DOC } from "../../telemetry/policy.ts";

export interface ConfigOptions {
  readonly subcommand?: "view" | "get" | "set" | "unset" | "edit" | "validate" | "translate" | "telemetry";
  readonly key?: string;
  readonly value?: string;
  readonly format?: "json" | "yaml" | "table";
  readonly path?: string;
  readonly source?: "raw" | "resolved";
}

export interface ConfigResult {
  readonly config?: GlobalConfig;
  readonly key?: string;
  readonly value?: unknown;
  readonly format: "json" | "yaml" | "table";
  readonly telemetry?: {
    readonly enabled: boolean;
    readonly source: CliTelemetrySource;
  };
  readonly changed?: boolean;
  readonly configPath?: string;
}

const writeRemediation =
  "`lando config set/unset/edit/validate/translate` are deferred to Beta. Edit `<userConfRoot>/config.yml` directly in Alpha.";

const unsupportedSubcommands = new Set(["set", "unset", "edit", "validate", "translate"]);

const resolvePath = (root: unknown, path: string): unknown => {
  const parts = path.split(".");
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
};

const formatYaml = (value: unknown, indent = 0): string => {
  const prefix = " ".repeat(indent);
  if (value === null || value === undefined) return `${prefix}null`;
  if (typeof value === "string") return `${prefix}${value}`;
  if (typeof value === "number" || typeof value === "boolean") return `${prefix}${String(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${prefix}[]`;
    return value.map((v) => `${prefix}- ${formatYaml(v, 0).trimStart()}`).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${prefix}{}`;
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          return `${prefix}${k}:\n${formatYaml(v, indent + 2)}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `${prefix}${k}:\n${formatYaml(v, indent + 2)}`;
        }
        return `${prefix}${k}: ${formatYaml(v, 0).trimStart()}`;
      })
      .join("\n");
  }
  return `${prefix}${String(value)}`;
};

const formatTable = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return String(value ?? "");
  }
  const flat: Array<[string, string]> = [];
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix === "" ? k : `${prefix}.${k}`;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, key);
      } else {
        flat.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
      }
    }
  };
  walk(value as Record<string, unknown>, "");
  const keyWidth = Math.max(3, ...flat.map(([k]) => k.length));
  const lines = [`${"KEY".padEnd(keyWidth)}  VALUE`];
  for (const [k, v] of flat) lines.push(`${k.padEnd(keyWidth)}  ${v}`);
  return lines.join("\n");
};

export const renderConfigResult = (result: ConfigResult): string => {
  const target =
    result.telemetry !== undefined
      ? {
          telemetry: result.telemetry,
          ...(result.changed === undefined ? {} : { changed: result.changed }),
          ...(result.configPath === undefined ? {} : { configPath: result.configPath }),
          policy: TELEMETRY_RETENTION_POLICY_DOC,
        }
      : result.value !== undefined
        ? result.value
        : (result.config ?? {});
  if (result.format === "json") return JSON.stringify(target, null, 2);
  if (result.format === "yaml") return formatYaml(target);
  return formatTable(target);
};

const telemetryConfigPath = (): string =>
  join(resolveConfigFileRoot(resolveUserConfRoot(), envOverlay()), "config.yml");

const configReadError = (path: string, cause: unknown): ConfigError =>
  new ConfigError({ message: `Failed to read global config: ${path}`, path, cause });

const configWriteError = (path: string, cause: unknown): ConfigError =>
  new ConfigError({ message: `Failed to write global config: ${path}`, path, cause });

const readConfigObject = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    return parseMinimalYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    throw configReadError(path, cause);
  }
};

const writeConfigObject = (path: string, configObject: Record<string, unknown>): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, emitLandofileYaml(configObject));
  } catch (cause) {
    throw configWriteError(path, cause);
  }
};

const setTelemetryEnabled = (
  configObject: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> => {
  const telemetry = configObject.telemetry;
  return {
    ...configObject,
    telemetry: {
      ...(telemetry !== null && typeof telemetry === "object" && !Array.isArray(telemetry) ? telemetry : {}),
      enabled,
    },
  };
};

const telemetryConfig = (
  action: string | undefined,
  format: ConfigOptions["format"],
): Effect.Effect<ConfigResult, ConfigError | NotImplementedError> => {
  const configPath = telemetryConfigPath();
  return Effect.try({
    try: () => {
      const normalizedAction = action ?? "status";
      if (normalizedAction !== "off" && normalizedAction !== "status") {
        throw new NotImplementedError({
          message: `meta:config telemetry ${normalizedAction} is not supported.`,
          commandId: "meta:config",
          remediation: "Use `lando config telemetry status` or `lando config telemetry off`.",
        });
      }

      if (normalizedAction === "off") {
        const current = readConfigObject(configPath);
        writeConfigObject(configPath, setTelemetryEnabled(current, false));
      }

      return {
        telemetry: resolveCliTelemetryState(),
        changed: normalizedAction === "off",
        configPath,
        format: format ?? "table",
      };
    },
    catch: (cause) => {
      if (cause instanceof ConfigError || cause instanceof NotImplementedError) return cause;
      return configWriteError(configPath, cause);
    },
  });
};

export const config = (
  options: ConfigOptions = {},
): Effect.Effect<ConfigResult, ConfigError | LandoCommandError | NotImplementedError, ConfigService> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (subcommand === "telemetry") return yield* telemetryConfig(options.key, options.format);

    if (unsupportedSubcommands.has(subcommand)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:config ${subcommand} is deferred to Beta.`,
          commandId: "meta:config",
          remediation: writeRemediation,
        }),
      );
    }

    const configService = yield* ConfigService;
    const userDataRoot = yield* configService.get("userDataRoot");
    const userConfRoot = yield* configService.get("userConfRoot");
    const defaultProviderId = yield* configService.get("defaultProviderId");
    const merged = {
      userDataRoot,
      userConfRoot,
      defaultProviderId,
    } as GlobalConfig;

    const key = options.key ?? options.path;
    const value = key === undefined ? undefined : resolvePath(merged, key);
    return {
      config: merged,
      ...(key === undefined ? {} : { key }),
      ...(value === undefined ? {} : { value }),
      format: options.format ?? "table",
    };
  });
