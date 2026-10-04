import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import {
  ROUTER_LAST_RESORT_HTTPS_PORT,
  ROUTER_LAST_RESORT_HTTP_PORT,
  type RouterPortPair,
  routerPortPairFromAcquisition,
} from "@lando/sdk/schema";

export type LeftoverProxyPortPair = RouterPortPair;

const LAST_FALLBACK: LeftoverProxyPortPair = {
  httpPort: ROUTER_LAST_RESORT_HTTP_PORT,
  httpsPort: ROUTER_LAST_RESORT_HTTPS_PORT,
};

export const leftoverProxyPortRemediation = (ports: LeftoverProxyPortPair): string =>
  `A leftover rootlessport is holding the Traefik loopback ports (127.0.0.1:${ports.httpPort} / 127.0.0.1:${ports.httpsPort}). Run \`lando global:stop\`. If that does not release the ports, terminate the leftover rootlessport process manually before retrying. Run \`lando setup\` if the managed runtime is broken.`;

export const LEFTOVER_PROXY_PORT_REMEDIATION = leftoverProxyPortRemediation(LAST_FALLBACK);

export const isLeftoverProxyPortBindMessage = (message: string, ports?: LeftoverProxyPortPair): boolean => {
  const pair = ports ?? LAST_FALLBACK;
  const mentionsPort =
    new RegExp(`\\b${pair.httpPort}\\b`).test(message) || new RegExp(`\\b${pair.httpsPort}\\b`).test(message);
  if (!mentionsPort) return false;
  return (
    /address already in use/iu.test(message) || /EADDRINUSE/u.test(message) || /rootlessport/iu.test(message)
  );
};

export const pairFromAcquisition = routerPortPairFromAcquisition;

export const readPersistedTraefikPublishPair = (): LeftoverProxyPortPair => {
  try {
    const paths = makeLandoPaths();
    const stateFile = join(paths.globalAppRoot, "proxy-traefik", "dynamic", ".lando-port-acquisition.json");
    return pairFromAcquisition(JSON.parse(readFileSync(stateFile, "utf8")));
  } catch (error) {
    if (error instanceof Error) return LAST_FALLBACK;
    throw error;
  }
};
