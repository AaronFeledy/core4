import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
  isCoreServiceEnvKey,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import { composeConfigMounts } from "./compose-configs.ts";
import {
  ContainerPlanError,
  containerHealthcheck,
  normalizeCommand,
  normalizeEntrypoint,
} from "./create-values.ts";
import { AGENT_SESSION_LABEL } from "./labels.ts";
import { realizePodmanComposeKnobs } from "./podman/compose-knobs.ts";
import { podmanNetworkNames } from "./podman/networks.ts";

export const CREATE_CONFIG_LABEL = "dev.lando.create-config";

const agentEnvironment: Readonly<Record<string, string>> = {
  SSH_AUTH_SOCK: `${AGENT_SOCKET_CONTAINER_DIR.ssh}/${SSH_AGENT_SOCKET_NAME}`,
  GNUPGHOME: "/tmp/lando-gnupg",
  LANDO_GPG_AGENT_SOCKET: `${AGENT_SOCKET_CONTAINER_DIR.gpg}/${GPG_AGENT_SOCKET_NAME}`,
  LANDO_GPG_KEYRING: "/run/lando/gpg-agent-keys",
};
export const createConfigFingerprint = (
  plan: AppPlan,
  service: ServicePlan,
  labels: Readonly<Record<string, string>>,
): string => {
  const knobs = realizePodmanComposeKnobs(service, {
    onInvalid: (message, details) => {
      throw new ContainerPlanError(message, details);
    },
  });
  const artifact = service.artifact;
  const appMount = service.appMount;
  const sessionMountTargets = new Set<string>();
  if (service.environment.SSH_AUTH_SOCK === agentEnvironment.SSH_AUTH_SOCK) {
    sessionMountTargets.add(AGENT_SOCKET_CONTAINER_DIR.ssh);
  }
  if (service.environment.LANDO_GPG_AGENT_SOCKET === agentEnvironment.LANDO_GPG_AGENT_SOCKET) {
    sessionMountTargets.add(AGENT_SOCKET_CONTAINER_DIR.gpg);
    sessionMountTargets.add("/run/lando/gpg-agent-keys");
  }
  if (service.environment.LANDO_HOST_PROXY_SESSION !== undefined) {
    sessionMountTargets.add("/run/lando/host-proxy.sock");
    sessionMountTargets.add("/usr/local/lib/lando/host-proxy-client");
    sessionMountTargets.add("/usr/local/bin/lando");
  }
  const projection = {
    artifact: artifact?.kind === "ref" ? { ref: artifact.ref, digest: artifact.digest } : undefined,
    command: normalizeCommand(service.command),
    entrypoint: normalizeEntrypoint(service.entrypoint),
    user: service.user === "" ? undefined : service.user,
    workingDirectory: service.workingDirectory,
    environment: Object.fromEntries(
      Object.entries(service.environment).filter(
        ([key, value]) =>
          key !== "LANDO_HOST_IP" &&
          !(isCoreServiceEnvKey(key) && key.startsWith("LANDO_HOST_PROXY_")) &&
          agentEnvironment[key] !== value,
      ),
    ),
    appMount:
      appMount === undefined
        ? undefined
        : {
            source: appMount.source,
            target: appMount.target,
            readOnly: appMount.readOnly,
            realization: appMount.realization,
          },
    mounts: service.mounts.filter((mount) => !sessionMountTargets.has(mount.target)),
    storage: service.storage,
    configs: composeConfigMounts(plan, service),
    labels: Object.fromEntries(
      Object.entries(labels).filter(([key]) => key !== CREATE_CONFIG_LABEL && key !== AGENT_SESSION_LABEL),
    ),
    healthcheck: containerHealthcheck(service.healthcheck),
    endpoints: service.endpoints.map((endpoint) => {
      switch (endpoint._tag) {
        case "published":
          return {
            kind: endpoint._tag,
            port: endpoint.port,
            protocol: endpoint.protocol === "udp" ? "udp" : "tcp",
            publication: endpoint.publication,
          };
        case "internal":
          return endpoint.protocol === "unix"
            ? { kind: endpoint._tag, protocol: endpoint.protocol, socketPath: endpoint.socketPath }
            : { kind: endpoint._tag, port: endpoint.port, protocol: endpoint.protocol };
      }
    }),
    hostAliases: service.hostAliases,
    networks: Object.fromEntries(
      podmanNetworkNames(plan).map((name) => [
        name,
        name === landoSharedNetworkName(plan) ? landoServiceNetworkAliases(plan, service) : [service.name],
      ]),
    ),
    knobs,
  };
  return `v1:${sha256Hex(canonicalJson(projection))}`;
};
