/**
 * `LANDO_CONFIG__*` env-overlay machinery and the config-file directory
 * resolver, shared by `ConfigService` (`core/src/services/config.ts`) and the
 * Effect-free cold-start root resolver (`core/src/config/roots.ts`).
 *
 * `resolveConfigFileRoot` decides WHICH `config.yml` is read. It is the single
 * source of truth so `resolveUserDataRoot` (fast path) and `ConfigService`
 * locate the same file even when `LANDO_CONFIG__user_conf_root` redirects the
 * conf root — otherwise `lando shellenv` and `lando setup` could read different
 * files and disagree on PATH. This module imports nothing from `@lando/sdk`
 * (its error barrel pulls Effect) and takes the base conf root as a parameter
 * rather than importing `roots.ts`, so the dependency stays one-directional.
 */

export const ENV_OVERLAY_PREFIX = "LANDO_CONFIG__";

// `default_provider_id` / `DEFAULT_PROVIDER_ID` -> camelCase key `defaultProviderId`.
const segmentToKey = (segment: string): string =>
  segment.toLowerCase().replace(/_+([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const isTelemetryEnabledPath = (path: ReadonlyArray<string>): boolean =>
  path.length === 2 && path[0] === "telemetry" && path[1] === "enabled";

const parseTelemetryEnabledOverlay = (raw: string): boolean => raw === "1" || raw.toLowerCase() === "true";

// JSON-parseable values become objects/arrays/numbers/booleans/null; anything
// else (e.g. a bare `podman`) is kept verbatim as a string.
const parseOverlayValue = (raw: string, path: ReadonlyArray<string>): unknown => {
  if (raw === "" && path.length === 1 && path[0] === "defaultProviderId") return null;
  if (isTelemetryEnabledPath(path)) return parseTelemetryEnabledOverlay(raw);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assignDeep = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const existing = cursor[key];
    if (!isPlainObject(existing)) {
      const nested: Record<string, unknown> = {};
      cursor[key] = nested;
      cursor = nested;
    } else {
      cursor = existing;
    }
  }
  cursor[path[path.length - 1] as string] = value;
};

export const deepMerge = (
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
};

/**
 * Generic `LANDO_CONFIG__path__to__value` overlay: a single delimiter-driven
 * mechanism that can target any config path, replacing the earlier set of
 * single-purpose env vars.
 */
export const envOverlay = (
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(ENV_OVERLAY_PREFIX)) continue;
    const rawPath = name.slice(ENV_OVERLAY_PREFIX.length);
    const segments = rawPath.split("__").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    const path = segments.map(segmentToKey);
    assignDeep(overlay, path, parseOverlayValue(value, path));
  }
  return overlay;
};

export const rootEnvOverlay = (
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  if (env.LANDO_USER_DATA_ROOT !== undefined) overlay.userDataRoot = env.LANDO_USER_DATA_ROOT;
  if (env.LANDO_USER_CONF_ROOT !== undefined) overlay.userConfRoot = env.LANDO_USER_CONF_ROOT;
  if (env.LANDO_USER_CACHE_ROOT !== undefined) overlay.userCacheRoot = env.LANDO_USER_CACHE_ROOT;
  if (env.LANDO_SYSTEM_PLUGIN_ROOT !== undefined) overlay.systemPluginRoot = env.LANDO_SYSTEM_PLUGIN_ROOT;
  return overlay;
};

/**
 * Resolve the directory that holds `config.yml`, honoring the
 * `LANDO_CONFIG__user_conf_root` overlay over `LANDO_USER_CONF_ROOT` over the
 * provided `baseConfRoot` default. A non-string overlay value falls back to
 * `baseConfRoot`.
 */
export const resolveConfigFileRoot = (
  baseConfRoot: string,
  overlay: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): string => {
  const roots = deepMerge({ userConfRoot: baseConfRoot }, deepMerge(rootEnvOverlay(env), overlay));
  return typeof roots.userConfRoot === "string" ? roots.userConfRoot : baseConfRoot;
};
