/**
 * Env names injected only to connect the in-container shim to its host session.
 * They carry live transport/auth material and must never be persisted or
 * forwarded back inside a serialized runLando request env.
 */
import { HOST_PROXY_CREDENTIAL_ENV_NAMES } from "@lando/sdk/secrets";

export const HOST_PROXY_RUN_LANDO_ENV_NAMES: ReadonlyArray<string> = [
  "LANDO_HOST_PROXY_TRANSPORT",
  "LANDO_HOST_PROXY_SOCKET",
  "LANDO_HOST_PROXY_URL",
  ...HOST_PROXY_CREDENTIAL_ENV_NAMES,
  "LANDO_HOST_PROXY_APP",
  "LANDO_HOST_PROXY_DEPTH",
];

export const isHostProxyRunLandoEnvName = (name: string): boolean =>
  HOST_PROXY_RUN_LANDO_ENV_NAMES.includes(name);
