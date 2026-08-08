/**
 * Env names injected only to connect the in-container shim to its host session.
 * They carry live transport/auth material and must never be persisted or
 * forwarded back inside a serialized runLando request env.
 */
export const HOST_PROXY_RUN_LANDO_ENV_NAMES: ReadonlyArray<string> = [
  "LANDO_HOST_PROXY_TRANSPORT",
  "LANDO_HOST_PROXY_SOCKET",
  "LANDO_HOST_PROXY_URL",
  "LANDO_HOST_PROXY_TOKEN",
  "LANDO_HOST_PROXY_SESSION",
  "LANDO_HOST_PROXY_APP",
  "LANDO_HOST_PROXY_DEPTH",
  "LANDO_HOST_PROXY_SHIM",
];

export const isHostProxyRunLandoEnvName = (name: string): boolean =>
  HOST_PROXY_RUN_LANDO_ENV_NAMES.includes(name);
