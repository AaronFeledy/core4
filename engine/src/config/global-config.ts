import { type ConfigLayer, configRecord, mergeGlobalConfigSources } from "@lando/paths/config-sources";
import { AgentEnvPatternError, ConfigError } from "@lando/sdk/errors";
import {
  GlobalConfig,
  HostEvents,
  LOG_LEVELS,
  type ValidationIssue,
  formatHostEventsIssueMessage,
  formatValidationIssuePath,
  hostEventsSemanticIssues,
  suggestionForUnknownKey,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Result, Schema, type SchemaIssue } from "effect";
import { findAgentEnvPatternNames } from "./agent-env.ts";
import { attributeConfigIssue, globalConfigIssuesError } from "./global-config-errors.ts";

const excessPaths = (issue: SchemaIssue.Issue, path: readonly PropertyKey[] = []): readonly string[] => {
  switch (issue._tag) {
    case "Pointer":
      return excessPaths(issue.issue, [...path, ...issue.path]);
    case "Encoding":
      return excessPaths(issue.issue, path);
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap((child) => excessPaths(child, path));
    case "Filter":
      return excessPaths(issue.issue, path);
    case "UnexpectedKey":
      return [JSON.stringify(path.map((key) => (typeof key === "number" ? key : String(key))))];
    default:
      return [];
  }
};

export const decodeGlobalConfigSources = (
  stack: readonly ConfigLayer[],
  options: { readonly excessKeys: "warn" | "error"; readonly commandIds?: ReadonlySet<string> },
): Result.Result<{ readonly config: GlobalConfig; readonly warnings: readonly string[] }, ConfigError> => {
  const file = stack.find((layer) => layer.layer === "config-file");
  const path = file !== undefined && "file" in file ? file.file : "";
  for (const layer of stack) {
    if ("error" in layer && layer.error !== undefined) {
      return Result.fail(
        new ConfigError({
          path: layer.file,
          message: `Invalid YAML in config file ${layer.file}: ${layer.error}`,
          remediation: `Fix the YAML syntax with \`lando config edit\` or edit ${layer.file} directly.`,
        }),
      );
    }
  }
  const merged = mergeGlobalConfigSources(stack);
  const tree = merged.tree;
  const warnings: string[] = [];
  for (const layer of stack) {
    for (const [key, value] of Object.entries(layer.tree)) {
      if (
        typeof value === "string" &&
        [...value].some((char) => char.charCodeAt(0) < 32) &&
        (key.endsWith("Root") || /^[A-Za-z]:/.test(value))
      ) {
        warnings.push(
          `config.yml ${key} decoded with control characters. Double-quoted YAML treats \\t and \\n as escapes. Use single quotes or \\\\.`,
        );
      }
    }
  }
  const hostDecoded = Object.hasOwn(tree, "hostEvents")
    ? Schema.decodeUnknownResult(HostEvents)(tree.hostEvents, {
        errors: "all",
        onExcessProperty: "error",
        reportInput: false,
      })
    : undefined;
  const hostIssues =
    hostDecoded === undefined
      ? []
      : Result.isSuccess(hostDecoded)
        ? hostEventsSemanticIssues(hostDecoded.success)
        : validationIssuesFromCause(hostDecoded.failure).map((issue) => ({
            ...issue,
            path: ["hostEvents", ...issue.path],
            message: formatHostEventsIssueMessage({ ...issue, message: "Invalid host event configuration." }),
          }));
  const schemaTree =
    hostIssues.length === 0
      ? tree
      : Object.fromEntries(Object.entries(tree).filter(([key]) => key !== "hostEvents"));
  const strict = Schema.decodeUnknownResult(GlobalConfig)(schemaTree, {
    errors: "all",
    onExcessProperty: "error",
    reportInput: false,
  });
  if (options.excessKeys === "warn" && Result.isFailure(strict)) {
    const paths = new Set(excessPaths(strict.failure.issue));
    for (const issue of validationIssuesFromCause(strict.failure)) {
      if (!paths.has(JSON.stringify(issue.path))) continue;
      const origin = merged.originAt(issue.path).layer;
      const label =
        "file" in origin ? (origin.layer === "config-file" ? "config.yml" : origin.file) : origin.layer;
      warnings.push(
        `Unknown ${label} key "${formatValidationIssuePath(issue.path)}".${issue.suggestion === undefined ? "" : ` ${issue.suggestion}`}`,
      );
    }
  }
  const decoded =
    options.excessKeys === "warn" && Result.isFailure(strict)
      ? Schema.decodeUnknownResult(GlobalConfig)(schemaTree, { errors: "all", reportInput: false })
      : strict;
  const issues: ValidationIssue[] = [...hostIssues];
  if (typeof tree.renderer === "string" && !["lando", "json", "plain", "verbose"].includes(tree.renderer))
    issues.push({ path: ["renderer"], message: "Expected one of lando, json, plain, verbose." });
  if (typeof tree.logLevel === "string" && !LOG_LEVELS.some((level) => level === tree.logLevel))
    issues.push({ path: ["logLevel"], message: `Expected one of ${LOG_LEVELS.join(", ")}.` });
  if (Result.isFailure(decoded)) issues.push(...validationIssuesFromCause(decoded.failure));
  else if (decoded.success.hostEvents !== undefined && hostIssues.length === 0)
    issues.push(...hostEventsSemanticIssues(decoded.success.hostEvents));
  let cause: AgentEnvPatternError | undefined;
  if (Result.isSuccess(decoded) && decoded.success.notify?.enabled && options.commandIds !== undefined) {
    const commandIds = options.commandIds;
    decoded.success.notify.commands.forEach((id, index) => {
      if (!commandIds.has(id))
        issues.push({
          path: ["notify", "commands", index],
          message: "Unknown canonical command id.",
          suggestion:
            suggestionForUnknownKey(id, [...commandIds]) ??
            "Choose a registered command id, or install and enable the plugin that contributes it.",
        });
    });
  }
  if (options.excessKeys === "error" && Result.isSuccess(decoded) && decoded.success.agentEnv !== undefined) {
    const agentEnv = decoded.success.agentEnv;
    const patterns = findAgentEnvPatternNames([...(agentEnv.allow ?? []), ...(agentEnv.deny ?? [])]);
    if (patterns.length > 0) {
      cause = new AgentEnvPatternError({
        message: `agentEnv allow/deny entries must be exact env-var names, not patterns: ${patterns.join(", ")}.`,
        patterns,
        remediation:
          "Replace wildcard or pattern entries with exact env-var names (e.g. CLAUDE_CODE, not CLAUDE_*).",
      });
      for (const field of ["allow", "deny"] as const) {
        agentEnv[field]?.forEach((name, index) => {
          if (patterns.includes(name))
            issues.push({
              path: ["agentEnv", field, index],
              message: cause?.message ?? "Use an exact env-var name.",
            });
        });
      }
    }
  }
  if (issues.length > 0)
    return Result.fail(
      globalConfigIssuesError(
        issues.map((issue) => attributeConfigIssue(issue, merged.originAt(issue.path))),
        path,
        cause,
      ),
    );
  if (Result.isFailure(decoded)) return Result.fail(globalConfigIssuesError([], path));
  return Result.succeed({ config: decoded.success, warnings });
};

export const decodeGlobalConfigFile = (
  input: unknown,
  file: string,
  options?: { readonly commandIds?: ReadonlySet<string> },
): Result.Result<GlobalConfig, ConfigError> => {
  if (!configRecord(input))
    return Result.fail(
      globalConfigIssuesError(
        [
          attributeConfigIssue(
            { path: [], message: "Config must be a map." },
            { layer: { layer: "config-file", file, tree: {} }, path: [] },
          ),
        ],
        file,
      ),
    );
  return Result.map(
    decodeGlobalConfigSources([{ layer: "config-file", file, tree: input }], {
      ...options,
      excessKeys: "error",
    }),
    (value) => value.config,
  );
};
