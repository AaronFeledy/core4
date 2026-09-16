import { APPLY_REMEDIATION, type StartFailureRemediation } from "@lando/container-runtime/podman/bring-up";

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
): string => {
  const haystack = `${message}\n${detailBody(details)}`;
  if (isManagedNftMissingMessage(haystack)) return NFT_REMEDIATION;
  const leftoverForService = serviceName === undefined || serviceName === "traefik";
  if (leftoverForService && isLeftoverProxyPortBindMessage(haystack, ports)) {
    return ports === undefined ? LEFTOVER_PROXY_PORT_REMEDIATION : leftoverProxyPortRemediation(ports);
  }
  return APPLY_REMEDIATION;
};

export const landoStartFailureRemediation: StartFailureRemediation = ({ service, message, details }) =>
  startFailureRemediation(message, details, readPersistedTraefikPublishPair(), service);
