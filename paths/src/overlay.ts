/**
 * Effect-free environment projection shared by layered config acquisition
 * and cold-start readers. Root discovery and merging live in config-sources.ts.
 */

export const ENV_OVERLAY_PREFIX = "LANDO_CONFIG__";

const FRIENDLY_ENV_OVERLAYS = [
  ["LANDO_NOTIFY_ENABLED", ["notify", "enabled"]],
  ["LANDO_NOTIFY_THRESHOLD_MS", ["notify", "thresholdMs"]],
  ["LANDO_NOTIFY_COMMANDS", ["notify", "commands"]],
  ["LANDO_NETWORK_CA_INJECT_INTO_SERVICES", ["network", "ca", "injectIntoServices"]],
  ["LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES", ["network", "proxy", "injectIntoServices"]],
  ["LANDO_ROUTER_HTTP_PORT", ["router", "httpPort"]],
  ["LANDO_ROUTER_HTTPS_PORT", ["router", "httpsPort"]],
  ["LANDO_ROUTER_BIND_ADDRESS", ["router", "bindAddress"]],
  ["LANDO_ROUTER_HTTP_FALLBACKS", ["router", "httpFallbacks"]],
  ["LANDO_ROUTER_HTTPS_FALLBACKS", ["router", "httpsFallbacks"]],
  ["LANDO_APP_ENV", ["appEnv"]],
  ["LANDO_APP_LABELS", ["appLabels"]],
] as const;

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

const isNonArrayObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assignDeep = (target: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const existing = cursor[key];
    if (!isNonArrayObject(existing)) {
      const nested: Record<string, unknown> = {};
      cursor[key] = nested;
      cursor = nested;
    } else {
      cursor = existing;
    }
  }
  cursor[path[path.length - 1] as string] = value;
};

/**
 * Generic `LANDO_CONFIG__path__to__value` overlays are applied first;
 * friendly env aliases take precedence.
 */
export const envOverlay = (env: Record<string, string | undefined> = process.env): Record<string, unknown> =>
  envOverlayWithVariables(env).tree;

export const envOverlayWithVariables = (
  env: Record<string, string | undefined>,
): { readonly tree: Record<string, unknown>; readonly variables: ReadonlyMap<string, string> } => {
  const overlay: Record<string, unknown> = {};
  const variables = new Map<string, string>();
  const assign = (name: string, path: readonly string[], value: unknown): void => {
    if (
      path.length === 1 &&
      path[0] !== undefined &&
      Object.hasOwn(ROOT_ENV_VARIABLES, path[0]) &&
      value === ""
    )
      return;
    const key = JSON.stringify(path);
    for (const previous of variables.keys()) {
      const segments: unknown = JSON.parse(previous);
      if (Array.isArray(segments) && path.every((segment, index) => segments[index] === segment)) {
        variables.delete(previous);
      }
    }
    assignDeep(overlay, path, value);
    variables.set(key, name);
  };
  for (const [key, value] of Object.entries(rootEnvOverlay(env))) {
    const name = ROOT_ENV_VARIABLES[key];
    if (name !== undefined) assign(name, [key], value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith(ENV_OVERLAY_PREFIX)) continue;
    const rawPath = name.slice(ENV_OVERLAY_PREFIX.length);
    const segments = rawPath.split("__").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    const path = segments.map(segmentToKey);
    if (path[0] === "hostEvents") continue;
    if ((path[0] === "appEnv" || path[0] === "appLabels") && path.length !== 1) continue;
    assign(name, path, parseOverlayValue(value, path));
  }
  for (const [name, path] of FRIENDLY_ENV_OVERLAYS) {
    const value = env[name];
    if (value === undefined) continue;
    assign(name, path, parseOverlayValue(value, path));
  }
  return { tree: overlay, variables };
};

export const ROOT_ENV_VARIABLES: Readonly<Record<string, string>> = {
  userConfRoot: "LANDO_USER_CONF_ROOT",
  userCacheRoot: "LANDO_USER_CACHE_ROOT",
  userDataRoot: "LANDO_USER_DATA_ROOT",
  systemPluginRoot: "LANDO_SYSTEM_PLUGIN_ROOT",
};

export const rootEnvOverlay = (
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  if (env.LANDO_USER_DATA_ROOT !== undefined && env.LANDO_USER_DATA_ROOT !== "")
    overlay.userDataRoot = env.LANDO_USER_DATA_ROOT;
  if (env.LANDO_USER_CONF_ROOT !== undefined && env.LANDO_USER_CONF_ROOT !== "")
    overlay.userConfRoot = env.LANDO_USER_CONF_ROOT;
  if (env.LANDO_USER_CACHE_ROOT !== undefined && env.LANDO_USER_CACHE_ROOT !== "")
    overlay.userCacheRoot = env.LANDO_USER_CACHE_ROOT;
  if (env.LANDO_SYSTEM_PLUGIN_ROOT !== undefined && env.LANDO_SYSTEM_PLUGIN_ROOT !== "")
    overlay.systemPluginRoot = env.LANDO_SYSTEM_PLUGIN_ROOT;
  return overlay;
};
