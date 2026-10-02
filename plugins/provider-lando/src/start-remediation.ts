import { APPLY_REMEDIATION, type StartFailureRemediation } from "@lando/container-runtime/podman/bring-up";
import { normalizeHostPlatform } from "@lando/paths";
import type { HostPlatform } from "@lando/sdk/schema";

import {
  LEFTOVER_PROXY_PORT_REMEDIATION,
  type LeftoverProxyPortPair,
  isLeftoverProxyPortBindMessage,
  leftoverProxyPortRemediation,
  readPersistedTraefikPublishPair,
} from "./leftover-proxy-port.ts";

const NFT_REMEDIATION =
  "Netavark could not find nft. Run `lando setup` so Lando can provision nft into the managed runtime, then retry `lando start`. Do not install nft by hand and do not set network_backend=pasta.";

export const isManagedNftMissingMessage = (message: string): boolean =>
  /unable to execute ["']nft["']/iu.test(message) || /nftables error:.*\bnft\b/iu.test(message);

const detailBody = (details: unknown): string => {
  if (typeof details !== "object" || details === null || !("body" in details)) return "";
  const body = details.body;
  return typeof body === "string" ? body : "";
};

export const startFailureRemediation = (
  message: string,
  details?: unknown,
  ports?: LeftoverProxyPortPair,
  serviceName?: string,
  platform: HostPlatform = "linux",
): string => {
  const haystack = `${message}\n${detailBody(details)}`;
  if (isManagedNftMissingMessage(haystack)) return NFT_REMEDIATION;
  const leftoverForService = serviceName === undefined || serviceName === "traefik";
  if (leftoverForService && isLeftoverProxyPortBindMessage(haystack, ports)) {
    if (platform === "win32") {
      const selected = ports === undefined ? "" : ` (HTTP ${ports.httpPort}, HTTPS ${ports.httpsPort})`;
      return `The managed Windows Podman machine could not publish Traefik's loopback ports${selected}. Run \`lando global:stop\`, then retry \`lando start\`. If the conflict remains, inspect the selected ports with \`lando doctor\` and configure available router ports.`;
    }
    return ports === undefined ? LEFTOVER_PROXY_PORT_REMEDIATION : leftoverProxyPortRemediation(ports);
  }
  return APPLY_REMEDIATION;
};

export const makeLandoStartFailureRemediation =
  (platform: HostPlatform): StartFailureRemediation =>
  ({ service, message, details }) =>
    startFailureRemediation(message, details, readPersistedTraefikPublishPair(), service, platform);

export const landoStartFailureRemediation = makeLandoStartFailureRemediation(normalizeHostPlatform());
