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
export const HELPER_LIFECYCLE_LABEL = "dev.lando.helper-lifecycle" as const;
export const HELPER_OWNER_MACHINE_LABEL = "dev.lando.helper-owner-machine" as const;
export const HELPER_OWNER_PID_DOMAIN_LABEL = "dev.lando.helper-owner-pid-domain" as const;
export const HELPER_OWNER_PID_LABEL = "dev.lando.helper-owner-pid" as const;
export const HELPER_OWNER_BOOT_LABEL = "dev.lando.helper-owner-boot" as const;
export const HELPER_OWNER_START_LABEL = "dev.lando.helper-owner-start" as const;
export const HELPER_LIFECYCLE_PROCESS = "process" as const;
export const HELPER_LIFECYCLE_RETAIN = "retain" as const;
export const VOLUME_SNAPSHOT_LABEL = "dev.lando.volume-snapshot" as const;
export const SNAPSHOT_ID_LABEL = "dev.lando.snapshot-id" as const;
export const SNAPSHOT_STORE_LABEL = "dev.lando.snapshot-store" as const;
export const VOLUME_INSTANCE_LABEL = "dev.lando.volume-instance" as const;
export const SCRATCH_LABEL = "dev.lando.scratch" as const;
export const SCRATCH_ID_LABEL = "dev.lando.scratch-id" as const;
export const AGENT_SESSION_LABEL = "dev.lando.agent-session" as const;
/** Digest of the container-facing host-proxy contract a container was created with. */
export const HOST_PROXY_CONTRACT_LABEL = "dev.lando.host-proxy-contract" as const;
export const HOST_PROXY_TRANSPORT_EXTENSION_KEY = "@lando/core/host-proxy-transport";
/** Container directory bound from the app's container-facing host directory: credentials and local socket. */
export const HOST_PROXY_CONTAINER_DIR = "/run/lando/host-proxy";
/** Container path of a host-proxy socket bridged from a provider machine, bound as a file. */
export const HOST_PROXY_CONTAINER_BRIDGE_SOCKET = "/run/lando/host-proxy.sock";
export const HOST_PROXY_CONTAINER_LANDO = "/usr/local/bin/lando";
/** Commands bound to the host-proxy client shim. */
export const HOST_PROXY_COMMAND_TARGETS: ReadonlyArray<string> = [
  HOST_PROXY_CONTAINER_LANDO,
  "/usr/local/bin/xdg-open",
  "/usr/local/bin/open",
];
/** Every container path the host-proxy overlay can mount. */
export const HOST_PROXY_MOUNT_TARGETS: ReadonlySet<string> = new Set([
  HOST_PROXY_CONTAINER_DIR,
  HOST_PROXY_CONTAINER_BRIDGE_SOCKET,
  ...HOST_PROXY_COMMAND_TARGETS,
]);
export const SSH_AGENT_OVERLAY_LABEL = "dev.lando.ssh-agent-overlay" as const;
export const GPG_AGENT_OVERLAY_LABEL = "dev.lando.gpg-agent-overlay" as const;

export const hostProxyContractDigest = (extensions: ServicePlan["extensions"]): string | undefined => {
  const transport = extensions[HOST_PROXY_TRANSPORT_EXTENSION_KEY];
  if (typeof transport !== "object" || transport === null || !("contractDigest" in transport))
    return undefined;
  return typeof transport.contractDigest === "string" && /^[a-f0-9]{16}$/u.test(transport.contractDigest)
    ? transport.contractDigest
    : undefined;
};

export const containerIntegrationLabels = (
  environment: ServicePlan["environment"],
  labels: Readonly<Record<string, string>> = {},
  extensions: ServicePlan["extensions"] = {},
): Record<string, string> => {
  const {
    [HOST_PROXY_CONTRACT_LABEL]: _hostProxy,
    [SSH_AGENT_OVERLAY_LABEL]: _ssh,
    [GPG_AGENT_OVERLAY_LABEL]: _gpg,
    ...authored
  } = labels;
  const contractDigest = hostProxyContractDigest(extensions);
  return {
    ...authored,
    ...(contractDigest === undefined ? {} : { [HOST_PROXY_CONTRACT_LABEL]: contractDigest }),
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
