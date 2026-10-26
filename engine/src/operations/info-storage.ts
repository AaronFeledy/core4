import {
  GPG_AGENT_OVERLAY_LABEL,
  HOST_PROXY_SESSION_LABEL,
  SSH_AGENT_OVERLAY_LABEL,
  containerIntegrationLabels,
} from "@lando/container-runtime/labels";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type ObservedMount,
  type ServiceInfoMount,
  type ServicePlan,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { stripGpgAgentOverlay } from "../subsystems/gpg-agent/overlay.ts";
import {
  HOST_PROXY_MOUNT_TARGETS,
  stripHostProxyRunLando,
} from "../subsystems/host-proxy/transport-feature.ts";
import { stripSshAgentOverlay } from "../subsystems/ssh-agent/overlay.ts";

type PlannedMount = {
  readonly fact: ObservedMount;
  readonly realized: ObservedMount;
  readonly lifetime: ServiceInfoMount["lifetime"];
  readonly provenance: ServiceInfoMount["provenance"];
};

const windowsSource = (source: string): boolean => /^[a-z]:[\\/]/iu.test(source) || source.startsWith("\\\\");

const sameSource = (left: string, right: string): boolean =>
  left === right ||
  (windowsSource(left) &&
    windowsSource(right) &&
    left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase());

const lifetime = (type: ObservedMount["type"]): ServiceInfoMount["lifetime"] => {
  switch (type) {
    case "bind":
      return "retained";
    case "tmpfs":
      return "container";
    case "volume":
    case "unknown":
      return "unknown";
  }
};

export const projectServiceMounts = (
  plan: AppPlan,
  service: ServicePlan,
  runtime?: Pick<ServiceRuntimeInfo, "mounts" | "labels">,
): readonly ServiceInfoMount[] | undefined => {
  const observation = runtime?.mounts;
  const hostProxyActive =
    service.environment.LANDO_HOST_PROXY_SESSION !== undefined ||
    runtime?.labels?.[HOST_PROXY_SESSION_LABEL] !== undefined;
  const integrationLabels = containerIntegrationLabels(service.environment);
  const sshAgentActive =
    integrationLabels[SSH_AGENT_OVERLAY_LABEL] === "true" ||
    runtime?.labels?.[SSH_AGENT_OVERLAY_LABEL] === "true";
  const gpgAgentActive =
    integrationLabels[GPG_AGENT_OVERLAY_LABEL] === "true" ||
    runtime?.labels?.[GPG_AGENT_OVERLAY_LABEL] === "true";
  const planned: PlannedMount[] = [];
  const servicePlan = { ...plan, services: { [service.name]: service } };
  const hostProxyClean = hostProxyActive ? stripHostProxyRunLando(servicePlan) : servicePlan;
  const gpgClean = gpgAgentActive ? stripGpgAgentOverlay(hostProxyClean) : hostProxyClean;
  const cleanPlan = sshAgentActive ? stripSshAgentOverlay(gpgClean) : gpgClean;
  const userMounts = cleanPlan.services[service.name]?.mounts ?? [];
  const internalTargets = new Set(
    service.mounts.filter((mount) => !userMounts.includes(mount)).map((mount) => String(mount.target)),
  );
  if (sshAgentActive) internalTargets.add(AGENT_SOCKET_CONTAINER_DIR.ssh);
  if (gpgAgentActive) {
    internalTargets.add(AGENT_SOCKET_CONTAINER_DIR.gpg);
    internalTargets.add("/run/lando/gpg-agent-keys");
  }
  if (hostProxyActive) {
    for (const target of HOST_PROXY_MOUNT_TARGETS) internalTargets.add(target);
  }
  for (const mount of service.mounts) {
    if (mount.origin === "integration") internalTargets.add(mount.target);
    else if (mount.origin !== undefined) internalTargets.delete(mount.target);
  }
  for (const mount of service.mounts) {
    if (mount.origin === "integration" || (mount.origin === undefined && internalTargets.has(mount.target)))
      continue;
    const fact: ObservedMount = {
      type: mount.type,
      target: mount.target,
      readOnly: mount.readOnly,
      ...(mount.type === "bind"
        ? { source: mount.source }
        : mount.type === "volume"
          ? { source: mount.store }
          : {}),
    };
    planned.push({
      fact,
      provenance: mount.origin,
      lifetime: mount.type === "tmpfs" ? "container" : "retained",
      realized:
        mount.type === "bind" && mount.realization === "accelerated" && mount.mountKey !== undefined
          ? {
              ...fact,
              type: "volume",
              source: fileSyncVolumeName(plan.name, String(service.name), mount.mountKey),
            }
          : fact,
    });
  }
  const observed = observation?.status === "present" ? observation.mounts : [];
  const matched = new Set<ObservedMount>();
  const result = planned.map(({ fact, realized, lifetime, provenance }): ServiceInfoMount => {
    const actual = observed.find(
      (mount) =>
        !matched.has(mount) &&
        mount.target === realized.target &&
        mount.type === realized.type &&
        (realized.source === undefined ||
          (mount.source !== undefined && sameSource(realized.source, mount.source))),
    );
    if (actual !== undefined) matched.add(actual);
    const ambiguous = observed.some(
      (mount) =>
        mount.target === realized.target &&
        (mount.type === "unknown" ||
          (mount.type === realized.type &&
            ((mount.source === undefined && realized.source !== undefined) ||
              (realized.type === "bind" &&
                realized.source !== undefined &&
                windowsSource(realized.source) &&
                mount.source !== undefined &&
                !windowsSource(mount.source))))),
    );
    return {
      ...fact,
      ...(actual?.readOnly === undefined ? {} : { readOnly: actual.readOnly }),
      origin: "planned",
      ...(provenance === undefined ? {} : { provenance }),
      lifetime,
      observation:
        actual !== undefined
          ? "present"
          : ambiguous || observation === undefined || observation.status === "unknown"
            ? "unknown"
            : "missing",
    };
  });
  for (const mount of observed) {
    if (matched.has(mount) || internalTargets.has(mount.target)) continue;
    result.push({ ...mount, origin: "runtime", observation: "present", lifetime: lifetime(mount.type) });
  }
  return result.length === 0 && observation?.status !== "present" ? undefined : result;
};
