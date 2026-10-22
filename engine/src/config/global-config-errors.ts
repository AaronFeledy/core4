import type { ConfigOrigin } from "@lando/paths/config-sources";
import { ConfigError } from "@lando/sdk/errors";
import {
  type ValidationIssue,
  formatValidationIssueLine,
  formatValidationIssuePath,
} from "@lando/sdk/schema";

export const attributeConfigIssue = (issue: ValidationIssue, origin: ConfigOrigin): ValidationIssue => {
  const { layer } = origin;
  const path = origin.path;
  const key = formatValidationIssuePath(issue.path);
  let source: NonNullable<ValidationIssue["source"]>;
  let fix: string;
  switch (layer.layer) {
    case "config-file":
      source = { layer: layer.layer, file: layer.file, path };
      fix =
        path[0] === "hostEvents"
          ? "Edit hostEvents in config.yml directly or use `lando config edit`."
          : `Run \`lando config unset ${key}\` or \`lando config set ${key} <value>\`.`;
      break;
    case "config-drop-in":
      source = { layer: layer.layer, file: layer.file, path };
      fix = `Edit ${layer.file}.`;
      break;
    case "env": {
      let variable = "LANDO_CONFIG__";
      for (let length = path.length; length >= 0; length -= 1) {
        const found = layer.variables.get(JSON.stringify(path.slice(0, length)));
        if (found !== undefined) {
          variable = found;
          break;
        }
      }
      source = { layer: "env", variable, path };
      fix = `Unset ${variable} or set it to a valid value.`;
      if (
        variable === "LANDO_NETWORK_CA_INJECT_INTO_SERVICES" ||
        variable === "LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES"
      ) {
        fix += ` Set ${variable} to "true" or "false", or unset it.`;
      }
      break;
    }
    case "host":
      source = { layer: "host", path };
      fix = `Fix the \`${key}\` host config option.`;
      break;
    case "default":
      source = { layer: "default", path };
      fix = `Fix the \`${key}\` default config option.`;
      break;
  }
  return { ...issue, source, suggestion: [issue.suggestion, fix].filter(Boolean).join(" ") };
};

export const globalConfigIssuesError = (
  issues: readonly ValidationIssue[],
  file: string,
  cause?: unknown,
): ConfigError => {
  const sources = [
    ...new Set(
      issues.map((issue) => {
        const source = issue.source;
        if (source?.layer === "env") return `environment override ${source.variable}`;
        if (source !== undefined && "file" in source) return source.file;
        if (source?.layer === "host") return "host config";
        return source?.layer ?? "default";
      }),
    ),
  ].sort();
  const first = issues[0];
  const detail = `${first === undefined ? "Invalid value." : formatValidationIssueLine({ ...first, message: /[.!?]$/.test(first.message) ? first.message : `${first.message}.` })}${issues.length > 1 ? ` (and ${issues.length - 1} more issues)` : ""}`;
  const onlyFile = sources.length === 1 && issues.every((issue) => issue.source?.layer === "config-file");
  return new ConfigError({
    path: file,
    message: onlyFile
      ? `Invalid config file ${file}: ${detail}`
      : `Invalid global configuration (${sources.join(" and ")}): ${detail}`,
    issues,
    remediation: [
      ...new Set(issues.map((issue) => issue.suggestion)),
      ...issues
        .filter((issue) => issue.source?.layer === "env")
        .map(
          (issue) => `Unset or fix the environment override for ${formatValidationIssuePath(issue.path)}.`,
        ),
      ...(issues.some((issue) => issue.source?.layer === "config-file" && issue.path[0] !== "hostEvents")
        ? [
            "Run `lando config validate`, then use `lando config set <key> <value>` / `lando config unset <key>`, or `lando config edit` to repair config.yml.",
          ]
        : []),
    ].join(" "),
    ...(cause === undefined ? {} : { cause }),
  });
};
