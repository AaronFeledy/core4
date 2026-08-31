import { readFileSync } from "node:fs";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";

export interface LeftoverProxyPortPair {
  readonly httpPort: number;
  readonly httpsPort: number;
}

const LAST_FALLBACK: LeftoverProxyPortPair = { httpPort: 38080, httpsPort: 38443 };

const isPortNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;

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

const pairFromAcquisition = (value: unknown): LeftoverProxyPortPair => {
  if (typeof value !== "object" || value === null) return LAST_FALLBACK;
  const bindHttpPort = "bindHttpPort" in value ? value.bindHttpPort : undefined;
  const bindHttpsPort = "bindHttpsPort" in value ? value.bindHttpsPort : undefined;
  if (isPortNumber(bindHttpPort) && isPortNumber(bindHttpsPort)) {
    return { httpPort: bindHttpPort, httpsPort: bindHttpsPort };
  }
  if ("mode" in value && value.mode === "socket-helper") return LAST_FALLBACK;
  const httpPort = "httpPort" in value ? value.httpPort : undefined;
  const httpsPort = "httpsPort" in value ? value.httpsPort : undefined;
  if (isPortNumber(httpPort) && isPortNumber(httpsPort)) {
    return { httpPort, httpsPort };
  }
  return LAST_FALLBACK;
};

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
