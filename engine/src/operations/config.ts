import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Effect, Predicate, Result, Schema } from "effect";

import {
  AgentEnvPatternError,
  ConfigError,
  type LandoCommandError,
  LandofileWriteValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { GlobalConfig, GlobalConfigView, hostEventsConfigIssues } from "@lando/sdk/schema";
import type { ConfigService } from "@lando/sdk/services";

import { envOverlay, resolveConfigFileRoot } from "@lando/paths/overlay";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import { type ValidationIssue, validationIssue } from "@lando/sdk/schema";
import { writeFileAtomicViaRename } from "../cache/atomic";
import { getAtPath, parsePathSegments } from "../config-write/dot-path";
import { editorFailedError, noEditorError, runSetVerb, runUnsetVerb } from "../config-write/verbs";
import { type ValueType, decodeIssues, writeValidationErrorFromIssues } from "../config-write/write-core";
import { findAgentEnvPatternNames } from "../config/agent-env";
import { resolveUserConfRoot } from "../config/roots";
import { type CliTelemetrySource, resolveCliTelemetryState } from "../runtime/cli-options";
import { loadGlobalConfigView } from "../services/config.ts";

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
      ...(Predicate.isObject(telemetry) ? telemetry : {}),
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

const decodeGlobalConfig = (input: unknown) =>
  Schema.decodeUnknownResult(GlobalConfig)(input, { onExcessProperty: "error", errors: "all" });

const agentEnvPatternError = (
  decoded: ReturnType<typeof decodeGlobalConfig>,
): AgentEnvPatternError | undefined => {
  if (Result.isFailure(decoded)) return undefined;
  const agentEnv = decoded.success.agentEnv;
  if (agentEnv === undefined) return undefined;
  const patterns = findAgentEnvPatternNames([...(agentEnv.allow ?? []), ...(agentEnv.deny ?? [])]);
  if (patterns.length === 0) return undefined;
  return new AgentEnvPatternError({
    message: `agentEnv allow/deny entries must be exact env-var names, not patterns: ${patterns.join(", ")}.`,
    patterns,
    remediation:
      "Replace wildcard or pattern entries with exact env-var names (e.g. CLAUDE_CODE, not CLAUDE_*).",
  });
};

const configValidationError = (
  path: string,
  issues: readonly ValidationIssue[],
  key?: string,
): LandofileWriteValidationError =>
  writeValidationErrorFromIssues({ file: path, issues, ...(key === undefined ? {} : { path: key }) });

const hostEventsTreeIssues = (tree: Record<string, unknown>): readonly ValidationIssue[] =>
  Object.hasOwn(tree, "hostEvents") ? hostEventsConfigIssues(tree.hostEvents) : [];

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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError | AgentEnvPatternError> {
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
    decode: decodeGlobalConfig,
    afterDecode: agentEnvPatternError,
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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError | AgentEnvPatternError> {
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
    decode: decodeGlobalConfig,
    afterDecode: agentEnvPatternError,
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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError | AgentEnvPatternError> {
  const path = resolveConfigWritePath(options);
  const tree = yield* readConfigTree(path);
  const decoded = decodeGlobalConfig(tree);
  const issues = [...decodeIssues(decoded), ...hostEventsTreeIssues(tree)];
  if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues));
  const patternError = agentEnvPatternError(decoded);
  if (patternError !== undefined) return yield* Effect.fail(patternError);
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
): Effect.fn.Return<ConfigResult, ConfigError | LandofileWriteValidationError | AgentEnvPatternError> {
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
  const decoded = decodeGlobalConfig(parsed);
  const issues = [...decodeIssues(decoded), ...hostEventsTreeIssues(parsed)];
  if (issues.length > 0) return yield* Effect.fail(configValidationError(path, issues));
  const patternError = agentEnvPatternError(decoded);
  if (patternError !== undefined) return yield* Effect.fail(patternError);
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
  options: ConfigOptions = {},
): Effect.fn.Return<
  ConfigResult,
  | ConfigError
  | LandoCommandError
  | LandofileWriteValidationError
  | NotImplementedError
  | AgentEnvPatternError,
  ConfigService
> {
  const subcommand = options.subcommand ?? "view";
  if (subcommand === "telemetry") return yield* telemetryConfig(options.key, options.format);
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

  const merged = yield* loadGlobalConfigView;

  const key = options.key ?? options.path;
  const value = key === undefined ? undefined : getAtPath(merged, key);
  return {
    config: merged,
    ...(key === undefined ? {} : { key }),
    ...(value === undefined ? {} : { value }),
    format: options.format ?? "table",
  };
});
