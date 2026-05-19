import { Effect } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { NotImplementedError } from "@lando/sdk/errors";
import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

export interface ConfigOptions {
  readonly subcommand?: "view" | "get" | "set" | "unset" | "edit" | "validate" | "translate";
  readonly key?: string;
  readonly value?: string;
  readonly format?: "json" | "yaml" | "table";
  readonly path?: string;
  readonly source?: "raw" | "resolved";
}

export interface ConfigResult {
  readonly config: GlobalConfig;
  readonly key?: string;
  readonly value?: unknown;
  readonly format: "json" | "yaml" | "table";
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
  const target = result.value !== undefined ? result.value : result.config;
  if (result.format === "json") return JSON.stringify(target, null, 2);
  if (result.format === "yaml") return formatYaml(target);
  return formatTable(target);
};

export const config = (
  options: ConfigOptions = {},
): Effect.Effect<ConfigResult, ConfigError | LandoCommandError | NotImplementedError, ConfigService> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (unsupportedSubcommands.has(subcommand)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:config ${subcommand} is deferred to Beta.`,
          commandId: "meta:config",
          specSection: "spec/08-cli-and-tooling.md",
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
