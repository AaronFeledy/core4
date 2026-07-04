import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Effect, Either, Schema } from "effect";

import {
  ConfigError,
  type LandoCommandError,
  LandofileWriteValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { envOverlay, resolveConfigFileRoot } from "../../config/overlay.ts";
import { resolveUserConfRoot } from "../../config/roots.ts";
import { parseMinimalYaml } from "../../config/yaml-min.ts";
import { type EditorRunner, createDefaultEditorRunner } from "../../recipes/prompts/editor-command.ts";
import { type CliTelemetrySource, resolveCliTelemetryState } from "../../runtime/cli-options.ts";
import { TELEMETRY_RETENTION_POLICY_DOC } from "../../telemetry/policy.ts";
import {
  type ValueType,
  applySetMutation,
  applyUnsetMutation,
  decodeIssues,
  emitConfigYaml,
  writeValidationErrorFromIssues,
} from "../config-write/write-core.ts";

export interface ConfigOptions {
  readonly subcommand?: "view" | "get" | "set" | "unset" | "edit" | "validate" | "translate" | "telemetry";
  readonly key?: string;
  readonly value?: string;
  readonly type?: ValueType;
  readonly format?: "json" | "yaml" | "table";
  readonly path?: string;
  readonly source?: "raw" | "resolved";
  readonly dryRun?: boolean;
  readonly editor?: string;
  readonly configPath?: string;
  readonly editorRunner?: EditorRunner;
}

export interface ConfigResult {
  readonly config?: GlobalConfig;
  readonly subcommand?: string;
  readonly key?: string;
  readonly value?: unknown;
  readonly path?: string;
  readonly format: "json" | "yaml" | "table";
  readonly telemetry?: {
    readonly enabled: boolean;
    readonly source: CliTelemetrySource;
  };
  readonly changed?: boolean;
  readonly dryRun?: boolean;
  readonly valid?: boolean;
  readonly issues?: ReadonlyArray<string>;
  readonly configPath?: string;
}

const ResultGlobalConfigSchema = Schema.Struct({
  userDataRoot: Schema.optional(Schema.String),
  userConfRoot: Schema.optional(Schema.String),
  userCacheRoot: Schema.optional(Schema.String),
  systemPluginRoot: Schema.optional(Schema.String),
  defaultProviderId: Schema.optional(Schema.Union(Schema.String, Schema.Literal(null))),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
    }),
  ),
  renderer: Schema.optional(Schema.String),
  network: Schema.optional(
    Schema.Struct({
      proxy: Schema.optional(
        Schema.Struct({
          http: Schema.optional(Schema.Union(Schema.String, Schema.Literal(null))),
          https: Schema.optional(Schema.Union(Schema.String, Schema.Literal(null))),
          noProxy: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      ca: Schema.optional(
        Schema.Struct({
          trustHost: Schema.optional(Schema.Boolean),
          certs: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});

export const ConfigResultSchema = Schema.Struct({
  config: Schema.optional(ResultGlobalConfigSchema),
  subcommand: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  format: Schema.Union(Schema.Literal("json"), Schema.Literal("yaml"), Schema.Literal("table")),
  telemetry: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      source: Schema.Union(
        Schema.Literal("flag"),
        Schema.Literal("env"),
        Schema.Literal("config"),
        Schema.Literal("default"),
      ),
    }),
  ),
  changed: Schema.optional(Schema.Boolean),
  dryRun: Schema.optional(Schema.Boolean),
  valid: Schema.optional(Schema.Boolean),
  issues: Schema.optional(Schema.Array(Schema.String)),
  configPath: Schema.optional(Schema.String),
});

const translateRemediation =
  "`lando config translate` is app-scoped. Use `lando app config translate` inside an app.";

const unsupportedSubcommands = new Set(["translate"]);

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

const renderWriteResult = (result: ConfigResult): string => {
  const file = result.configPath ?? "";
  switch (result.subcommand) {
    case "set":
      return result.dryRun === true
        ? `${file}: would set ${result.key} (dry run).`
        : `${file}: set ${result.key}.`;
    case "unset":
      if (result.changed !== true) return `${file}: ${result.key} was not present (no change).`;
      return result.dryRun === true
        ? `${file}: would unset ${result.key} (dry run).`
        : `${file}: unset ${result.key}.`;
    case "edit":
      return `${file}: saved edited config.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return file;
  }
};

export const renderConfigResult = (result: ConfigResult): string => {
  if (
    result.subcommand === "set" ||
    result.subcommand === "unset" ||
    result.subcommand === "edit" ||
    result.subcommand === "validate"
  ) {
    return renderWriteResult(result);
  }
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

const resolveConfigWritePath = (options: ConfigOptions): string =>
  options.configPath ?? telemetryConfigPath();

const readConfigTree = (path: string): Effect.Effect<Record<string, unknown>, ConfigError> =>
  Effect.try({ try: () => readConfigObject(path), catch: (cause) => configReadError(path, cause) });

const readConfigText = (path: string): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    catch: (cause) => configReadError(path, cause),
  });

const writeConfigAtomic = (path: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, content),
    catch: (cause) => configWriteError(path, cause),
  });

const decodeGlobalConfig = Schema.decodeUnknownEither(GlobalConfig);

const configValidationError = (
  path: string,
  issues: ReadonlyArray<string>,
  key?: string,
): LandofileWriteValidationError =>
  writeValidationErrorFromIssues({ file: path, issues, ...(key === undefined ? {} : { path: key }) });

const metaConfigSet = (
  options: ConfigOptions,
): Effect.Effect<ConfigResult, ConfigError | LandofileWriteValidationError> =>
  Effect.gen(function* () {
    const key = options.key;
    const raw = options.value;
    if (key === undefined || raw === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`meta config set` requires a <key.path> and a <value>.",
          file: "",
          issues: ["Missing key path or value."],
          remediation:
            "Usage: `lando config set <key.path> <value> [--type string|number|boolean|json|yaml]`.",
        }),
      );
    }
    const path = resolveConfigWritePath(options);
    const tree = yield* readConfigTree(path);
    const mutation = applySetMutation({ tree, key, raw, type: options.type ?? "string", file: path });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeGlobalConfig(next));
    if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues, key));
    const dryRun = options.dryRun === true;
    if (!dryRun) {
      const emitted = emitConfigYaml({ file: path, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeConfigAtomic(path, emitted.right);
    }
    return {
      subcommand: "set",
      key,
      value: mutation.right.value,
      changed: true,
      dryRun,
      configPath: path,
      format: options.format ?? "table",
    };
  });

const metaConfigUnset = (
  options: ConfigOptions,
): Effect.Effect<ConfigResult, ConfigError | LandofileWriteValidationError> =>
  Effect.gen(function* () {
    const key = options.key;
    if (key === undefined) {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "`meta config unset` requires a <key.path>.",
          file: "",
          issues: ["Missing key path."],
          remediation: "Usage: `lando config unset <key.path>`.",
        }),
      );
    }
    const path = resolveConfigWritePath(options);
    const tree = yield* readConfigTree(path);
    const mutation = applyUnsetMutation({ tree, key, file: path });
    if (Either.isLeft(mutation)) return yield* Effect.fail(mutation.left);
    const next = mutation.right.next;
    const issues = decodeIssues(decodeGlobalConfig(next));
    if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues, key));
    const dryRun = options.dryRun === true;
    if (!dryRun && mutation.right.changed) {
      const emitted = emitConfigYaml({ file: path, value: next, path: key });
      if (Either.isLeft(emitted)) return yield* Effect.fail(emitted.left);
      yield* writeConfigAtomic(path, emitted.right);
    }
    return {
      subcommand: "unset",
      key,
      changed: mutation.right.changed,
      dryRun,
      configPath: path,
      format: options.format ?? "table",
    };
  });

const metaConfigValidate = (
  options: ConfigOptions,
): Effect.Effect<ConfigResult, ConfigError | LandofileWriteValidationError> =>
  Effect.gen(function* () {
    const path = resolveConfigWritePath(options);
    const tree = yield* readConfigTree(path);
    const issues = decodeIssues(decodeGlobalConfig(tree));
    if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues));
    return {
      subcommand: "validate",
      valid: true,
      issues: [],
      configPath: path,
      format: options.format ?? "table",
    };
  });

const metaConfigEdit = (
  options: ConfigOptions,
): Effect.Effect<ConfigResult, ConfigError | LandofileWriteValidationError> =>
  Effect.gen(function* () {
    const path = resolveConfigWritePath(options);
    const content = yield* readConfigText(path);
    const runner =
      options.editorRunner ??
      createDefaultEditorRunner(
        options.editor === undefined
          ? {}
          : { env: { ...process.env, EDITOR: options.editor, VISUAL: options.editor } },
      );
    const edited = yield* Effect.promise(() => runner({ name: "lando-config", content, cwd: dirname(path) }));
    if (edited.kind === "no-editor") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: "No editor is configured.",
          file: path,
          issues: ["Neither $VISUAL nor $EDITOR is set."],
          remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
        }),
      );
    }
    if (edited.kind === "failed") {
      return yield* Effect.fail(
        new LandofileWriteValidationError({
          message: `The editor session failed: ${edited.reason}`,
          file: path,
          issues: [edited.reason],
          remediation:
            "Re-run `lando config edit` after resolving the editor error. The file was left unchanged.",
        }),
      );
    }
    const parsed = yield* Effect.try({
      try: () => parseMinimalYaml(edited.content),
      catch: (cause) =>
        new LandofileWriteValidationError({
          message: `The edited config is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
          file: path,
          issues: [cause instanceof Error ? cause.message : String(cause)],
          remediation: "Fix the YAML syntax so it parses, then retry. The file was left unchanged.",
        }),
    });
    const issues = decodeIssues(decodeGlobalConfig(parsed));
    if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues));
    yield* writeConfigAtomic(path, edited.content);
    return {
      subcommand: "edit",
      changed: true,
      valid: true,
      configPath: path,
      format: options.format ?? "table",
    };
  });

export const config = (
  options: ConfigOptions = {},
): Effect.Effect<
  ConfigResult,
  ConfigError | LandoCommandError | LandofileWriteValidationError | NotImplementedError,
  ConfigService
> =>
  Effect.gen(function* () {
    const subcommand = options.subcommand ?? "view";
    if (subcommand === "telemetry") return yield* telemetryConfig(options.key, options.format);
    if (subcommand === "set") return yield* metaConfigSet(options);
    if (subcommand === "unset") return yield* metaConfigUnset(options);
    if (subcommand === "validate") return yield* metaConfigValidate(options);
    if (subcommand === "edit") return yield* metaConfigEdit(options);

    if (unsupportedSubcommands.has(subcommand)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:config ${subcommand} is not available here.`,
          commandId: "meta:config",
          remediation: translateRemediation,
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
