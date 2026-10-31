import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
  isCoreServiceEnvKey,
  landoServiceNetworkAttachments,
} from "@lando/sdk/schema";
import { acceleratedMountVolume } from "./container-mounts.ts";
import { ContainerPlanError } from "./container-plan-error.ts";
import { containerHealthcheck, normalizeCommand, normalizeEntrypoint } from "./create-values.ts";
import { fileModeMountIdentity } from "./file-mode-mounts.ts";
import {
  AGENT_SESSION_LABEL,
  GPG_AGENT_OVERLAY_LABEL,
  HOST_PROXY_SESSION_LABEL,
  SSH_AGENT_OVERLAY_LABEL,
  containerIntegrationLabels,
} from "./labels.ts";
import { physicalListenerPorts, physicalPublications } from "./physical-publications.ts";
import { realizePodmanComposeKnobs } from "./podman/compose-knobs.ts";
import { compileServiceProbe } from "./service-probe.ts";

export const CREATE_CONFIG_LABEL = "dev.lando.create-config";

const CREATE_ARTIFACT_IDENTITY = "@lando/container-runtime/create-artifact";

const artifactInputIdentity = (service: ServicePlan): string => {
  const features = service.extensions["@lando/core/service-features"];
  const steps =
    typeof features === "object" && features !== null && "buildSteps" in features
      ? features.buildSteps
      : undefined;
  return sha256Hex(
    canonicalJson({
      artifact: service.artifact,
      buildSteps: Array.isArray(steps)
        ? steps.filter(
            (step: unknown) =>
              typeof step !== "object" || step === null || !("phase" in step) || step.phase !== "app",
          )
        : [],
    }),
  );
};

const createArtifactIdentity = (service: ServicePlan): string => {
  const identity = artifactInputIdentity(service);
  const retained = service.extensions[CREATE_ARTIFACT_IDENTITY];
  return typeof retained === "object" &&
    retained !== null &&
    "source" in retained &&
    typeof retained.source === "string" &&
    "realized" in retained &&
    retained.realized === identity
    ? retained.source
    : identity;
};

export const retainCreateArtifactIdentity = (source: ServicePlan, realized: ServicePlan): ServicePlan => ({
  ...realized,
  extensions: {
    ...realized.extensions,
    [CREATE_ARTIFACT_IDENTITY]: {
      source: createArtifactIdentity(source),
      realized: artifactInputIdentity(realized),
    },
  },
});

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
  const integrationLabels = containerIntegrationLabels(service.environment);
  const sshAgentActive = integrationLabels[SSH_AGENT_OVERLAY_LABEL] === "true";
  const gpgAgentActive = integrationLabels[GPG_AGENT_OVERLAY_LABEL] === "true";
  const sessionMountTargets = new Set<string>();
  if (sshAgentActive) {
    sessionMountTargets.add(AGENT_SOCKET_CONTAINER_DIR.ssh);
  }
  if (gpgAgentActive) {
    sessionMountTargets.add(AGENT_SOCKET_CONTAINER_DIR.gpg);
    sessionMountTargets.add("/run/lando/gpg-agent-keys");
  }
  if (service.environment.LANDO_HOST_PROXY_SESSION !== undefined) {
    sessionMountTargets.add("/run/lando/host-proxy.sock");
    sessionMountTargets.add("/usr/local/bin/lando");
    sessionMountTargets.add("/usr/local/bin/xdg-open");
    sessionMountTargets.add("/usr/local/bin/open");
  }
  const projection = {
    artifactProvenance: createArtifactIdentity(service),
    artifact: service.artifact,
    command: normalizeCommand(service.command),
    entrypoint: normalizeEntrypoint(service.entrypoint),
    user: service.user === "" ? undefined : service.user,
    workingDirectory: service.workingDirectory,
    environment: Object.fromEntries(
      Object.entries(service.environment).filter(
        ([key, value]) =>
          key !== "LANDO_HOST_IP" &&
          !(isCoreServiceEnvKey(key) && key.startsWith("LANDO_HOST_PROXY_")) &&
          !(agentEnvironment[key] === value && (key === "SSH_AUTH_SOCK" ? sshAgentActive : gpgAgentActive)),
      ),
    ),
    mounts: service.mounts
      .filter((mount) => !sessionMountTargets.has(mount.target))
      .map((mount) => {
        const common = { type: mount.type, target: mount.target, readOnly: mount.readOnly };
        switch (mount.type) {
          case "bind": {
            const fileIdentity = fileModeMountIdentity(mount);
            return {
              ...common,
              source:
                mount.realization === "accelerated"
                  ? acceleratedMountVolume(plan, service, mount)
                  : (fileIdentity?.source ?? mount.source),
              fileMode: mount.fileMode,
              contentDigest: fileIdentity?.digest,
              realization: mount.realization,
              createHostPath:
                mount.realization === "passthrough" && mount.createHostPath === false ? false : undefined,
            };
          }
          case "volume":
            return { ...common, store: mount.store, subpath: mount.subpath };
          case "tmpfs":
            return { ...common, options: mount.options };
          default:
            return mount satisfies never;
        }
      }),
    labels: Object.fromEntries(
      Object.entries(labels).filter(
        ([key]) =>
          key !== CREATE_CONFIG_LABEL &&
          key !== AGENT_SESSION_LABEL &&
          key !== HOST_PROXY_SESSION_LABEL &&
          key !== SSH_AGENT_OVERLAY_LABEL &&
          key !== GPG_AGENT_OVERLAY_LABEL,
      ),
    ),
    healthcheck: containerHealthcheck(service.healthcheck, plan, service),
    readiness:
      service.readiness === undefined
        ? undefined
        : {
            ...service.readiness,
            target:
              service.readiness.target === undefined
                ? undefined
                : {
                    port: service.readiness.target.port,
                    transport: service.readiness.target.transport,
                  },
            command:
              service.readiness.executionTarget === "host"
                ? service.readiness.command
                : compileServiceProbe(service.readiness, plan, service),
            ...(service.readiness.executionTarget === "host" ? { hostRoot: plan.root } : {}),
          },
    exposedPorts: physicalListenerPorts(service.endpoints),
    publications: physicalPublications(service.endpoints).sort((a, b) =>
      canonicalJson(a).localeCompare(canonicalJson(b)),
    ),
    hostAliases: service.hostAliases,
    networks: Object.fromEntries(
      landoServiceNetworkAttachments(plan, service).map(({ name, aliases }) => [name, aliases]),
    ),
    knobs,
  };
  return `v3:${sha256Hex(canonicalJson(projection))}`;
};
