import type { ConfigResult } from "@lando/engine/operations/config";
import { TELEMETRY_RETENTION_POLICY_DOC } from "@lando/telemetry/policy";
import { renderConfigWriteResult } from "./config-write-render";

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
  const writeResult = renderConfigWriteResult({
    file: result.configPath ?? "",
    subcommand: result.subcommand,
    key: result.key,
    changed: result.changed,
    dryRun: result.dryRun,
    editSavedLabel: "config",
  });
  if (writeResult !== undefined) return writeResult;
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
  return formatTable(target);
};
