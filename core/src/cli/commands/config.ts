import type { ConfigResult } from "@lando/engine/operations/config";
import { TELEMETRY_RETENTION_POLICY_DOC } from "@lando/telemetry/policy";

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
