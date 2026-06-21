import { readFileSync } from "node:fs";
import { join } from "node:path";

import { envOverlay, resolveConfigFileRoot } from "./overlay.ts";
import { parseMinimalYaml } from "./yaml-min.ts";

/**
 * Read a top-level string key from `config.yml` without constructing the Effect
 * runtime or loading the full `ConfigService`.
 *
 * `resolveUserDataRoot` runs on the cold-start fast path (`lando shellenv`,
 * bootstrap `none`, no Effect runtime), so it cannot use `ConfigService` (that
 * module imports Effect). It locates the file with the same overlay-aware
 * conf-root resolver (`resolveConfigFileRoot`, so `LANDO_CONFIG__user_conf_root`
 * is honored) and parses it with the same YAML subset parser `ConfigService`
 * uses, so env → config.yml → platform default resolution matches the merged
 * config layer on both paths. Any missing/unreadable/malformed file falls back
 * to `undefined`, and only a non-empty string value is accepted — a nested
 * block, `null`, or boolean falls back like the merged config layer would, so
 * shell startup never breaks.
 */
const readConfigYamlString = (key: string): string | undefined => {
  const confRoot = resolveConfigFileRoot(resolveUserConfRoot(), envOverlay());
  let text: string;
  try {
    text = readFileSync(join(confRoot, "config.yml"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseMinimalYaml(text);
  } catch {
    return undefined;
  }
  const value = parsed[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

export const resolveUserDataRoot = (): string => {
  // Resolution order: explicit env override → config.yml → platform default.
  // The env check short-circuits before any file IO so the fast path stays
  // IO-free when `LANDO_USER_DATA_ROOT` is set.
  if (process.env.LANDO_USER_DATA_ROOT !== undefined) return process.env.LANDO_USER_DATA_ROOT;
  const configured = readConfigYamlString("userDataRoot");
  if (configured !== undefined && configured !== "") return configured;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : `${process.env.HOME ?? "."}/.local/share`;
  return join(base, "lando");
};

export const resolveUserConfRoot = (): string => {
  if (process.env.LANDO_USER_CONF_ROOT !== undefined) return process.env.LANDO_USER_CONF_ROOT;
  return `${process.env.HOME ?? "."}/.lando`;
};

// Single place the `managed-files/` segment and `ledger.json` filename are
// spelled out; optional `userDataRoot` lets a caller that already resolved the
// data root (e.g. an injected test seam) reuse it.
export const managedFilesRoot = (appId: string, userDataRoot?: string): string =>
  join(userDataRoot ?? resolveUserDataRoot(), "managed-files", appId);

export const managedFileLedger = (appId: string, userDataRoot?: string): string =>
  join(managedFilesRoot(appId, userDataRoot), "ledger.json");
