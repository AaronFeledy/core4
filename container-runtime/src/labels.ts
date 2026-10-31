/**
 * Canonical `dev.lando.*` label keys.
 *
 * Volume ownership and storage class keys stay defined in their producer
 * modules. This file re-exports them so callers have one import path.
 */
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
} from "@lando/sdk/schema";

export { STORAGE_KIND_LABEL, STORAGE_SCOPE_LABEL } from "./volume-classes.ts";
export { VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL } from "./volume-ownership.ts";

export const APP_LABEL = "dev.lando.app" as const;
export const APP_ROOT_LABEL = "dev.lando.app-root" as const;
export const SERVICE_LABEL = "dev.lando.service" as const;
export const PROVIDER_LABEL = "dev.lando.provider" as const;
export const ROLE_LABEL = "dev.lando.role" as const;
export const STORE_LABEL = "dev.lando.store" as const;
export const DATA_HELPER_ROLE = "data-helper" as const;
export const VOLUME_SNAPSHOT_LABEL = "dev.lando.volume-snapshot" as const;
export const SNAPSHOT_ID_LABEL = "dev.lando.snapshot-id" as const;
export const SNAPSHOT_STORE_LABEL = "dev.lando.snapshot-store" as const;
export const VOLUME_INSTANCE_LABEL = "dev.lando.volume-instance" as const;
export const SCRATCH_LABEL = "dev.lando.scratch" as const;
export const SCRATCH_ID_LABEL = "dev.lando.scratch-id" as const;
export const AGENT_SESSION_LABEL = "dev.lando.agent-session" as const;
export const HOST_PROXY_SESSION_LABEL = "dev.lando.host-proxy-session" as const;
export const HOST_PROXY_TRANSPORT_EXTENSION_KEY = "@lando/core/host-proxy-transport";
export const SSH_AGENT_OVERLAY_LABEL = "dev.lando.ssh-agent-overlay" as const;
export const GPG_AGENT_OVERLAY_LABEL = "dev.lando.gpg-agent-overlay" as const;

export const hostProxySessionDigest = (extensions: ServicePlan["extensions"]): string | undefined => {
  const transport = extensions[HOST_PROXY_TRANSPORT_EXTENSION_KEY];
  if (typeof transport !== "object" || transport === null || !("sessionDigest" in transport))
    return undefined;
  return typeof transport.sessionDigest === "string" && /^[a-f0-9]{16}$/u.test(transport.sessionDigest)
    ? transport.sessionDigest
    : undefined;
};

export const containerIntegrationLabels = (
  environment: ServicePlan["environment"],
  labels: Readonly<Record<string, string>> = {},
  extensions: ServicePlan["extensions"] = {},
): Record<string, string> => {
  const {
    [HOST_PROXY_SESSION_LABEL]: _hostProxy,
    [SSH_AGENT_OVERLAY_LABEL]: _ssh,
    [GPG_AGENT_OVERLAY_LABEL]: _gpg,
    ...authored
  } = labels;
  const sessionDigest = hostProxySessionDigest(extensions);
  return {
    ...authored,
    ...(sessionDigest === undefined ? {} : { [HOST_PROXY_SESSION_LABEL]: sessionDigest }),
    ...(environment.SSH_AUTH_SOCK === `${AGENT_SOCKET_CONTAINER_DIR.ssh}/${SSH_AGENT_SOCKET_NAME}`
      ? { [SSH_AGENT_OVERLAY_LABEL]: "true" }
      : {}),
    ...(environment.LANDO_GPG_AGENT_SOCKET === `${AGENT_SOCKET_CONTAINER_DIR.gpg}/${GPG_AGENT_SOCKET_NAME}` &&
    environment.LANDO_GPG_KEYRING === "/run/lando/gpg-agent-keys"
      ? { [GPG_AGENT_OVERLAY_LABEL]: "true" }
      : {}),
  };
};

export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { [SCRATCH_LABEL]: "TRUE", [SCRATCH_ID_LABEL]: scratchId }
    : {};
};
