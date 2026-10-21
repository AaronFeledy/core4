import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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
import { type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { getAtPath, parsePathSegments } from "../config-write/dot-path";
import { editorFailedError, noEditorError, runSetVerb, runUnsetVerb } from "../config-write/verbs";
import { type ValueType, decodeIssues, writeValidationErrorFromIssues } from "../config-write/write-core";
import { configSourceStack, decodeConfigStack, validateConfigCandidate } from "../config/config-repair.ts";
import { recordConfigWarning } from "../config/config-warnings.ts";
import type { CliTelemetrySource } from "../runtime/cli-options";
import { GlobalConfigSources } from "../services/config.ts";

// allow: SIZE_OK — this behavior-preserving extraction keeps one config operation on one engine seam.

export interface EditorRunInput {
  readonly name: string;
  readonly content: string;
  readonly cwd: string;
}

export type EditorRunResult =
  | { readonly kind: "edited"; readonly content: string }
  | { readonly kind: "no-editor" }
  | { readonly kind: "failed"; readonly reason: string; readonly exitCode?: number };

export type EditorRunner = (input: EditorRunInput) => Promise<EditorRunResult>;

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
  readonly raw?: unknown;
  readonly config?: GlobalConfigView;
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

export const ConfigResultSchema = Schema.Struct({
  raw: Schema.optionalKey(Schema.Unknown),
  config: Schema.optionalKey(GlobalConfigView),
  subcommand: Schema.optionalKey(Schema.String),
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

const translateRemediation =
  "`lando config translate` is app-scoped. Use `lando app config translate` inside an app.";

const configReadError = (path: string, cause: unknown): ConfigError =>
  cause instanceof ConfigError
    ? cause
    : new ConfigError({
        message: `${cause instanceof MinimalYamlError ? "Invalid YAML in config file" : "Failed to read global config"} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        path,
        cause,
        ...(cause instanceof MinimalYamlError
          ? { remediation: "Fix the YAML syntax with `lando config edit` or edit config.yml directly." }
          : {}),
      });

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

const resolveConfigWritePath = (options: ConfigOptions): string => options.configPath ?? "";

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

const configValidationError = (
  path: string,
  issues: readonly ValidationIssue[],
  key?: string,
): LandofileWriteValidationError =>
  writeValidationErrorFromIssues({ file: path, issues, ...(key === undefined ? {} : { path: key }) });

const HOST_EVENTS_HAND_EDIT =
  "hostEvents can only be changed by editing config.yml. Use `lando config edit` or edit the file itself.";

const isHostEventsConfigPath = (key: string): boolean => {
  const segments = parsePathSegments(key);
  return segments?.[0]?.kind === "key" && segments[0].key === "hostEvents";
};

const hostEventsWriteError = (key: string, file: string): LandofileWriteValidationError =>
  new LandofileWriteValidationError({
    message: `Cannot change ${key} through \`meta config\`. ${HOST_EVENTS_HAND_EDIT}`,
    file,
    path: key,
    issues: [validationIssue(["hostEvents"], HOST_EVENTS_HAND_EDIT)],
    remediation: HOST_EVENTS_HAND_EDIT,
  });

const metaConfigSet = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError, GlobalConfigSources> {
  const key = options.key ?? options.path;
  const raw = options.value;
  if (key !== undefined && isHostEventsConfigPath(key)) {
    return yield* Effect.fail(hostEventsWriteError(key, resolveConfigWritePath(options)));
  }
  if (key === undefined || raw === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`meta config set` requires a <key.path> and a <value>.",
        file: "",
        issues: [validationIssue([], "Missing key path or value.")],
        remediation: "Usage: `lando config set <key.path> <value> [--type string|number|boolean|json|yaml]`.",
      }),
    );
  }
  const path = resolveConfigWritePath(options);
  const outcome = yield* runSetVerb({
    file: path,
    key,
    raw,
    type: options.type ?? "string",
    dryRun: options.dryRun === true,
    readTree: readConfigTree(path),
    decode: (input) => validateConfigCandidate(input, path),
    writeText: writeConfigAtomic,
  });
  return {
    subcommand: "set",
    key,
    value: outcome.value,
    changed: true,
    dryRun: outcome.dryRun,
    configPath: path,
    format: options.format ?? "table",
  };
});

const metaConfigUnset = Effect.fnUntraced(function* (
  options: ConfigOptions,
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError, GlobalConfigSources> {
  const key = options.key ?? options.path;
  if (key !== undefined && isHostEventsConfigPath(key)) {
    return yield* Effect.fail(hostEventsWriteError(key, resolveConfigWritePath(options)));
  }
  if (key === undefined) {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: "`meta config unset` requires a <key.path>.",
        file: "",
        issues: [validationIssue([], "Missing key path.")],
        remediation: "Usage: `lando config unset <key.path>`.",
      }),
    );
  }
  const path = resolveConfigWritePath(options);
  const outcome = yield* runUnsetVerb({
    file: path,
    key,
    dryRun: options.dryRun === true,
    readTree: readConfigTree(path),
    decode: (input) => validateConfigCandidate(input, path),
    writeText: writeConfigAtomic,
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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError, GlobalConfigSources> {
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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError, GlobalConfigSources> {
  const path = resolveConfigWritePath(options);
  const content = yield* readConfigText(path);
  const runner = options.editorRunner;
  if (runner === undefined) {
    return yield* Effect.fail(noEditorError(path));
  }
  const edited = yield* Effect.promise(() => runner({ name: "lando-config", content, cwd: dirname(path) }));
  if (edited.kind === "no-editor") {
    return yield* Effect.fail(noEditorError(path));
  }
  if (edited.kind === "failed") {
    return yield* Effect.fail(
      editorFailedError(
        path,
        edited.reason,
        "Re-run `lando config edit` after resolving the editor error. The file was left unchanged.",
      ),
    );
  }
  const parsed = yield* Effect.try({
    try: () => parseMinimalYaml(edited.content),
    catch: (cause) =>
      new LandofileWriteValidationError({
        message: `The edited config is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
        file: path,
        issues: [validationIssue([], cause instanceof Error ? cause.message : String(cause))],
        remediation: "Fix the YAML syntax so it parses, then retry. The file was left unchanged.",
      }),
  });
  const decoded = yield* validateConfigCandidate(parsed, path);
  const issues = decodeIssues(decoded);
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

export const config = Effect.fn("AppOperation.config")(function* (
  inputOptions: ConfigOptions = {},
): Effect.fn.Return<
  ConfigResult,
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

  if (subcommand !== "view" && subcommand !== "get") {
    return yield* Effect.fail(
      new LandofileWriteValidationError({
        message: `Unknown \`meta config\` subcommand: "${subcommand}".`,
        file: "",
        issues: [validationIssue([], `Unsupported subcommand: "${subcommand}".`)],
        remediation: "Usage: `lando meta config [view|get|set|unset|edit|validate|translate|telemetry]`.",
      }),
    );
  }

  const key = options.key ?? options.path;
  if (options.source === "raw") {
    const raw = yield* inputs.sources.user
      ? readConfigTree(resolveConfigWritePath(options))
      : Effect.succeed({});
    const value = key === undefined ? undefined : getAtPath(raw, key);
    return {
      raw,
      ...(key === undefined ? {} : { key }),
      ...(value === undefined ? {} : { value }),
      format: options.format ?? "table",
    };
  }
  const stack = yield* configSourceStack(options.configPath);
  const decoded = yield* decodeConfigStack(stack, "warn");
  if (Result.isFailure(decoded)) return yield* Effect.fail(decoded.failure);
  for (const message of decoded.success.warnings)
    yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
  const merged = yield* Schema.encodeEffect(GlobalConfigView)(decoded.success.config).pipe(
    Effect.mapError(
      (cause) => new ConfigError({ message: "Failed to project public global config.", cause }),
    ),
  );

  const value = key === undefined ? undefined : getAtPath(merged, key);
  return {
    config: merged,
    ...(key === undefined ? {} : { key }),
    ...(value === undefined ? {} : { value }),
    format: options.format ?? "table",
  };
});
