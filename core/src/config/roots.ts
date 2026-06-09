import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseMinimalYaml } from "./yaml-min.ts";

/**
 * Read a top-level string key from `<userConfRoot>/config.yml` without
 * constructing the Effect runtime or loading the full `ConfigService`.
 *
 * `resolveUserDataRoot` runs on the cold-start fast path (`lando shellenv`,
 * bootstrap `none`, no Effect runtime — spec §8.4 / PRD-02 US-004), so it cannot
 * use `ConfigService` (that module imports Effect). It instead parses the file
 * with the SAME zero-dependency YAML subset parser `ConfigService` uses, so the
 * config.yml layer required by the resolution order in spec §7.5
 * (`spec/07-landofile-and-config.md`) is honored identically on both paths. Any
 * missing/unreadable/malformed file falls back to `undefined`, and only a
 * non-empty string value is accepted — a nested block, `null`, or boolean falls
 * back like the merged config layer would, so shell startup never breaks.
 */
const readConfigYamlString = (key: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(join(resolveUserConfRoot(), "config.yml"), "utf8");
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
  // Spec §7.5 resolution order: explicit env override → config.yml → platform
  // default. The env check short-circuits before any file IO so the fast path
  // stays IO-free when `LANDO_USER_DATA_ROOT` is set.
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
