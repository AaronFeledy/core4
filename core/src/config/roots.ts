import { readFileSync } from "node:fs";
import { join } from "node:path";

const stripInlineComment = (value: string): string => value.replace(/\s+#.*$/, "");

const unquoteScalar = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

/**
 * Read a single **top-level scalar** from `<userConfRoot>/config.yml` without
 * constructing the Effect runtime or loading the full `ConfigService`.
 *
 * `resolveUserDataRoot` runs on the cold-start fast path (`lando shellenv`,
 * bootstrap `none`, no Effect runtime — spec §8.4 / PRD-02 US-004), so it cannot
 * use `ConfigService` (that module imports Effect). This zero-dependency reader
 * lets root resolution honor the config.yml layer required by the resolution
 * order in spec §7.5 (`spec/07-landofile-and-config.md`) while staying within
 * the fast-path budget. Any missing/unreadable/malformed file falls back to
 * `undefined` — shell startup must never break because global config has
 * unrelated content. Nested blocks (no scalar value) are ignored.
 */
const readConfigYamlTopLevelScalar = (key: string): string | undefined => {
  let text: string;
  try {
    text = readFileSync(join(resolveUserConfRoot(), "config.yml"), "utf8");
  } catch {
    return undefined;
  }
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.length === 0 || /^\s/u.test(rawLine)) continue;
    const match = stripInlineComment(rawLine).match(/^([A-Za-z0-9_-]+):(.*)$/u);
    if (match === null || match[1] !== key) continue;
    const nestedOrScalar = match[2]?.trim() ?? "";
    if (nestedOrScalar === "") return undefined;
    return unquoteScalar(nestedOrScalar);
  }
  return undefined;
};

export const resolveUserDataRoot = (): string => {
  // Spec §7.5 resolution order: explicit env override → config.yml → platform
  // default. The env check short-circuits before any file IO so the fast path
  // stays IO-free when `LANDO_USER_DATA_ROOT` is set.
  if (process.env.LANDO_USER_DATA_ROOT !== undefined) return process.env.LANDO_USER_DATA_ROOT;
  const configured = readConfigYamlTopLevelScalar("userDataRoot");
  if (configured !== undefined && configured !== "") return configured;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : `${process.env.HOME ?? "."}/.local/share`;
  return join(base, "lando");
};

export const resolveUserConfRoot = (): string => {
  if (process.env.LANDO_USER_CONF_ROOT !== undefined) return process.env.LANDO_USER_CONF_ROOT;
  return `${process.env.HOME ?? "."}/.lando`;
};
