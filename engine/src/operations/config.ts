import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";

import { Effect, Result, Schema } from "effect";

import {
  ConfigError,
  type LandoCommandError,
  LandofileWriteValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { GlobalConfigView } from "@lando/sdk/schema";

import { makeLandoPaths } from "@lando/paths";
import { mergeGlobalConfigSources } from "@lando/paths/config-sources";
import { MinimalYamlError, parseMinimalYaml } from "@lando/paths/yaml-min";
import { validationIssue } from "@lando/sdk/schema";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { getAtPath, parsePathSegments } from "../config-write/dot-path";
import type { EditorRunner } from "../config-write/editor.ts";
import {
  ConfigDescribeResultSchema,
  describeConfigKey,
  isAppOnlyConfigKey,
} from "../config-write/key-schema.ts";
import { runEditVerb, runSetVerb, runUnsetVerb } from "../config-write/verbs";
import type { ValueType } from "../config-write/write-core";
import { configSourceStack, decodeConfigStack, validateConfigCandidate } from "../config/config-repair.ts";
import { recordConfigWarning } from "../config/config-warnings.ts";
import { GlobalConfigSources } from "../services/config.ts";

// allow: SIZE_OK — this behavior-preserving extraction keeps one config operation on one engine seam.

export type { EditorRunInput, EditorRunResult, EditorRunner } from "../config-write/editor.ts";

export const CONFIG_SUBCOMMANDS = [
  "view",
  "get",
  "set",
  "unset",
  "edit",
  "validate",
  "describe",
  "telemetry",
  "translate",
] as const;
export interface ConfigOptions {
  readonly subcommand?: Exclude<(typeof CONFIG_SUBCOMMANDS)[number], "describe">;
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

const ConfigValueResultSchema = Schema.Struct({
  config: Schema.optionalKey(Schema.Never),
  raw: Schema.optionalKey(Schema.Never),
  subcommand: Schema.Literals(["set", "unset", "edit", "validate", "telemetry"]),
  key: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Unknown),
  path: Schema.optionalKey(Schema.String),
  format: Schema.Union([Schema.Literal("json"), Schema.Literal("yaml"), Schema.Literal("table")]),
  telemetry: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      source: Schema.Union([
        Schema.Literal("flag"),
        Schema.Literal("env"),
        Schema.Literal("config"),
        Schema.Literal("default"),
      ]),
    }),
  ),
  changed: Schema.optionalKey(Schema.Boolean),
  dryRun: Schema.optionalKey(Schema.Boolean),
  valid: Schema.optionalKey(Schema.Boolean),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
  configPath: Schema.optionalKey(Schema.String),
});
const ConfigReadFields = {
  changed: Schema.optionalKey(Schema.Never),
  dryRun: Schema.optionalKey(Schema.Never),
  valid: Schema.optionalKey(Schema.Never),
  issues: Schema.optionalKey(Schema.Never),
  telemetry: Schema.optionalKey(Schema.Never),
  configPath: Schema.optionalKey(Schema.Never),
};
const ConfigProjectionResultSchema = Schema.Struct({
  ...ConfigReadFields,
  subcommand: Schema.Literals(["get", "view"]),
  key: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
  config: Schema.optionalKey(Schema.Never),
  raw: Schema.optionalKey(Schema.Never),
  format: ConfigValueResultSchema.fields.format,
});
const ConfigViewFields = {
  ...ConfigReadFields,
  subcommand: Schema.optionalKey(Schema.Literal("view")),
  key: Schema.optionalKey(Schema.Never),
  value: Schema.optionalKey(Schema.Never),
  format: ConfigValueResultSchema.fields.format,
};
const ConfigReadResultSchema = Schema.Union([
  ConfigProjectionResultSchema,
  Schema.Struct({ ...ConfigViewFields, config: GlobalConfigView, raw: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ ...ConfigViewFields, raw: Schema.Unknown, config: Schema.optionalKey(Schema.Never) }),
]);
export const ConfigResultSchema = Schema.Union([
  ConfigReadResultSchema,
  ConfigValueResultSchema,
  Schema.Struct({ ...ConfigDescribeResultSchema.fields, format: ConfigValueResultSchema.fields.format }),
]);
export type ConfigResult = typeof ConfigResultSchema.Type;

const translateRemediation =
  "`lando config translate` is app-scoped. Use `lando app config translate` inside an app.";

const configReadError = (path: string, cause: unknown): ConfigError =>
  cause instanceof ConfigError
    ? cause
    : new ConfigError({
        message: `${cause instanceof MinimalYamlError ? "Invalid YAML in config file" : "Failed to read global config"} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
        remediation:
          cause instanceof MinimalYamlError
            ? "Fix the YAML syntax with `lando config edit` or edit config.yml directly."
            : `Fix permissions on ${path} or restore it, then retry the config command.`,
      });

const configWriteError = (path: string, cause: unknown): ConfigError =>
  new ConfigError({
    message: `Failed to write global config: ${path}`,
    path,
    cause,
    remediation: `Make ${path} writable, then retry \`lando config set\` or \`lando config edit\`.`,
  });

const readConfigObject = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  try {
    return parseMinimalYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    throw configReadError(path, cause);
  }
};

const resolveConfigWritePath = (options: ConfigOptions): string => options.configPath ?? "";

const readConfigTree = (path: string): Effect.Effect<Record<string, unknown>, ConfigError> =>
  Effect.try({ try: () => readConfigObject(path), catch: (cause) => configReadError(path, cause) });

const readConfigText = (path: string): Effect.Effect<string, ConfigError> =>
  Effect.try({
    try: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    catch: (cause) => configReadError(path, cause),
  });

const parseConfigText = (path: string) => (text: string) =>
  Effect.try({ try: () => parseMinimalYaml(text), catch: (cause) => configReadError(path, cause) });

const writeConfigAtomic = (path: string, content: string): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: () => writeFileAtomicViaRename(path, content),
    catch: (cause) => configWriteError(path, cause),
  });

const decodeConfigCandidate = (input: unknown, path: string, reportOtherSources = true) =>
  validateConfigCandidate(input, path, { reportOtherSources }).pipe(
    Effect.map(Result.mapError((error) => error.issues ?? [validationIssue([], error.message)])),
  );
const installationDocument = (path: string) => ({
  file: path,
  readText: readConfigText(path),
  parse: parseConfigText(path),
  editCommand: "lando config edit",
  schema: "GlobalConfig" as const,
  decode: (input: unknown) => decodeConfigCandidate(input, path),
  decodeBaseline: (input: unknown) => decodeConfigCandidate(input, path, false),
  writeText: writeConfigAtomic,
});
const HOST_EVENTS_HAND_EDIT =
  "hostEvents can only be changed by editing config.yml. Use `lando config edit` or edit the file itself.";

const isHostEventsConfigPath = (key: string): boolean => {
  const segments = parsePathSegments(key);
  return segments?.[0]?.kind === "key" && segments[0].key === "hostEvents";
};

const hostEventsWriteError = (key: string, file: string): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `Cannot change ${key} through \`lando config\`. ${HOST_EVENTS_HAND_EDIT}`,
    file,
    path: key,
    issues: [validationIssue(["hostEvents"], HOST_EVENTS_HAND_EDIT)],
    remediation: HOST_EVENTS_HAND_EDIT,
  });

const metaConfigSet = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<
  typeof ConfigValueResultSchema.Type,
  ConfigError | LandofileWriteValidationError,
  GlobalConfigSources
> {
  const key = options.key ?? options.path;
  const raw = options.value;
  if (key !== undefined && isHostEventsConfigPath(key)) {
    return yield* Effect.fail(hostEventsWriteError(key, resolveConfigWritePath(options)));
  }
  if (key === undefined || raw === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`lando config set` requires a <key.path> and a <value>.",
        file: "",
        issues: [validationIssue([], "Missing key path or value.")],
        remediation: "Usage: `lando config set <key.path> <value> [--type string|number|boolean|json|yaml]`.",
      }),
    );
  }
  const path = resolveConfigWritePath(options);
  if (isAppOnlyConfigKey(key)) {
    const first = parsePathSegments(key)?.[0];
    const root = first?.kind === "key" ? first.key : key;
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: `Cannot set ${key} in config.yml.`,
        file: path,
        path: key,
        issues: [validationIssue([root], `\`${root}\` is a Landofile key, not a config.yml key.`)],
        remediation: `Run \`lando app:config set ${key} <value>\` to change this app's Landofile.`,
      }),
    );
  }
  const outcome = yield* runSetVerb({
    ...installationDocument(path),
    key,
    raw,
    type: options.type,
    dryRun: options.dryRun === true,
  });
  return {
    subcommand: "set",
    key,
    value: outcome.value,
    changed: outcome.changed,
    dryRun: outcome.dryRun,
    configPath: path,
    format: options.format ?? "table",
  };
});

const metaConfigUnset = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<
  typeof ConfigValueResultSchema.Type,
  ConfigError | LandofileWriteValidationError,
  GlobalConfigSources
> {
  const key = options.key ?? options.path;
  if (key !== undefined && isHostEventsConfigPath(key)) {
    return yield* Effect.fail(hostEventsWriteError(key, resolveConfigWritePath(options)));
  }
  if (key === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`lando config unset` requires a <key.path>.",
        file: "",
        issues: [validationIssue([], "Missing key path.")],
        remediation: "Usage: `lando config unset <key.path>`.",
      }),
    );
  }
  const path = resolveConfigWritePath(options);
  const outcome = yield* runUnsetVerb({
    ...installationDocument(path),
    key,
    dryRun: options.dryRun === true,
  });
  return {
    subcommand: "unset",
    key,
    changed: outcome.changed,
    dryRun: outcome.dryRun,
    configPath: path,
    format: options.format ?? "table",
  };
});

const metaConfigValidate = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<
  typeof ConfigValueResultSchema.Type,
  ConfigError | LandofileWriteValidationError,
  GlobalConfigSources
> {
  const path = resolveConfigWritePath(options);
  const stack = yield* configSourceStack(path);
  const decoded = yield* decodeConfigStack(stack, "error");
  if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
  return {
    subcommand: "validate",
    valid: true,
    issues: [],
    configPath: path,
    format: options.format ?? "table",
  };
});

const metaConfigEdit = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<
  typeof ConfigValueResultSchema.Type,
  ConfigError | LandofileWriteValidationError,
  GlobalConfigSources
> {
  const path = resolveConfigWritePath(options);
  const runner = options.editorRunner;
  const outcome = yield* runEditVerb({
    ...installationDocument(path),
    dryRun: options.dryRun === true,
    openEditor:
      runner === undefined
        ? undefined
        : (content) => Effect.promise(() => runner({ name: "lando-config", content, cwd: dirname(path) })),
    parse: (content) =>
      Effect.try({
        try: () => parseMinimalYaml(content),
        catch: (cause) =>
          new LandofileWriteValidationError({
            message: `The edited config is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
            file: path,
            issues: [validationIssue([], cause instanceof Error ? cause.message : String(cause))],
            remediation: "Fix the YAML syntax so it parses, then retry. The file was left unchanged.",
          }),
      }),
  });
  return {
    subcommand: "edit",
    ...outcome,
    configPath: path,
    format: options.format ?? "table",
  };
});

/** `meta:config` input: every {@link ConfigOptions} subcommand plus the schema-only `describe`. */
export type MetaConfigOptions = Omit<ConfigOptions, "subcommand"> & {
  readonly subcommand?: ConfigOptions["subcommand"] | "describe";
};

/** Describes a `config.yml` key from the GlobalConfig schema; reads no config source. */
export const describeConfig = Effect.fn("AppOperation.configDescribe")(function* (
  options: Pick<ConfigOptions, "key" | "path" | "format">,
) {
  return {
    subcommand: "describe" as const,
    format: options.format ?? "table",
    ...(yield* describeConfigKey("installation", options.key ?? options.path)),
  };
});

export const config = Effect.fn("AppOperation.config")(function* (
  inputOptions: ConfigOptions = {},
): Effect.fn.Return<
  typeof ConfigValueResultSchema.Type | typeof ConfigReadResultSchema.Type,
  ConfigError | LandoCommandError | LandofileWriteValidationError | NotImplementedError,
  GlobalConfigSources
> {
  const inputs = yield* GlobalConfigSources;
  const options = {
    ...inputOptions,
    configPath:
      inputOptions.configPath ??
      makeLandoPaths({ ...inputs.rootOverrides, env: inputs.env, host: inputs.host, sources: inputs.sources })
        .configFile,
  };
  const subcommand = options.subcommand ?? "view";
  if (subcommand === "telemetry") {
    const action = options.key ?? "status";
    if (action !== "off" && action !== "status")
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:config telemetry ${action} is not supported.`,
          commandId: "meta:config",
          remediation: "Use `lando config telemetry status` or `lando config telemetry off`.",
        }),
      );
    if (action === "off") {
      const written = yield* metaConfigSet({
        ...options,
        key: "telemetry.enabled",
        value: "false",
        type: "boolean",
      });
      const stack = yield* configSourceStack(options.configPath);
      const merged = mergeGlobalConfigSources(stack);
      const enabled = getAtPath(merged.tree, "telemetry.enabled");
      const source = merged.originAt(["telemetry", "enabled"]).layer.layer === "env" ? "env" : "config";
      return {
        ...written,
        telemetry: { enabled: typeof enabled === "boolean" ? enabled : false, source },
        subcommand: "telemetry",
      };
    }
    const stack = yield* configSourceStack(options.configPath);
    const decoded = yield* decodeConfigStack(stack, "warn");
    if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
    for (const message of decoded.success.warnings)
      yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
    const origin = mergeGlobalConfigSources(stack).originAt(["telemetry", "enabled"]).layer.layer;
    const source = origin === "env" ? "env" : origin === "default" ? "default" : "config";
    return {
      subcommand: "telemetry",
      telemetry: { enabled: decoded.success.config.telemetry.enabled, source },
      changed: false,
      configPath: options.configPath,
      format: options.format ?? "table",
    };
  }
  if (subcommand === "set") return yield* metaConfigSet(options);
  if (subcommand === "unset") return yield* metaConfigUnset(options);
  if (subcommand === "validate") return yield* metaConfigValidate(options);
  if (subcommand === "edit") return yield* metaConfigEdit(options);

  if (subcommand === "translate") {
    return yield* Effect.fail(
      new NotImplementedError({
        message: `meta:config ${subcommand} is not available here.`,
        commandId: "meta:config",
        remediation: translateRemediation,
      }),
    );
  }

  const key = options.key ?? options.path;
  if (options.source === "raw") {
    const raw = yield* inputs.sources.user
      ? readConfigTree(resolveConfigWritePath(options))
      : Effect.succeed({});
    const value = key === undefined ? undefined : getAtPath(raw, key);
    if (key !== undefined)
      return {
        subcommand,
        key,
        ...(value === undefined ? {} : { value }),
        format: options.format ?? "table",
      };
    return {
      raw,
      format: options.format ?? "table",
    };
  }
  const stack = yield* configSourceStack(options.configPath);
  const decoded = yield* decodeConfigStack(stack, "warn");
  if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
  for (const message of decoded.success.warnings)
    yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
  const merged = yield* Schema.encodeEffect(GlobalConfigView)(decoded.success.config).pipe(
    mapFailures(
      (cause) =>
        new ConfigError({
          message: "Failed to project public global config.",
          cause,
          remediation: "Run `lando config validate` and repair invalid global config keys before retrying.",
        }),
    ),
  );

  const value = key === undefined ? undefined : getAtPath(merged, key);
  if (key !== undefined)
    return { subcommand, key, ...(value === undefined ? {} : { value }), format: options.format ?? "table" };
  return {
    config: merged,
    format: options.format ?? "table",
  };
});

/** Every `meta:config` subcommand, including the schema-only `describe`. */
export const runConfig = ({ subcommand, ...options }: MetaConfigOptions = {}) =>
  subcommand === "describe"
    ? describeConfig(options)
    : config(subcommand === undefined ? options : { ...options, subcommand });
