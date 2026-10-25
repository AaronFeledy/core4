import { HOST_PROXY_SESSION_LABEL } from "@lando/container-runtime/labels";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type ObservedMount,
  type ServiceInfoMount,
  type ServicePlan,
  fileSyncVolumeName,
  sameAppMountTarget,
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
  const planned: PlannedMount[] = [];
  const servicePlan = { ...plan, services: { [service.name]: service } };
  const cleanPlan = stripSshAgentOverlay(
    stripGpgAgentOverlay(hostProxyActive ? stripHostProxyRunLando(servicePlan) : servicePlan),
  );
  const userMounts = cleanPlan.services[service.name]?.mounts ?? [];
  const internalTargets = new Set(
    service.mounts.filter((mount) => !userMounts.includes(mount)).map((mount) => String(mount.target)),
  );
  internalTargets.add(AGENT_SOCKET_CONTAINER_DIR.ssh);
  internalTargets.add(AGENT_SOCKET_CONTAINER_DIR.gpg);
  if (hostProxyActive) {
    for (const target of HOST_PROXY_MOUNT_TARGETS) internalTargets.add(target);
  }
  const { appMount } = service;
  if (appMount !== undefined) {
    const fact: ObservedMount = {
      type: "bind",
      source: appMount.source,
      target: appMount.target,
      readOnly: appMount.readOnly,
    };
    planned.push({
      fact,
      lifetime: "retained",
      realized:
        appMount.realization === "accelerated"
          ? {
              ...fact,
              type: "volume",
              source: fileSyncVolumeName(plan.name, String(service.name), "app-mount"),
            }
          : fact,
    });
  }
  service.mounts.forEach((mount, index) => {
    if (internalTargets.has(mount.target)) return;
    if (sameAppMountTarget(appMount, mount)) return;
    const fact: ObservedMount = {
      type: mount.type,
      target: mount.target,
      readOnly: mount.readOnly,
      ...(mount.source === undefined ? {} : { source: mount.source }),
    };
    planned.push({
      fact,
      lifetime: lifetime(mount.type),
      realized:
        mount.type === "bind" && mount.realization === "accelerated"
          ? {
              ...fact,
              type: "volume",
              source: fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`),
            }
          : fact,
    });
  });
  for (const mount of service.storage) {
    if (internalTargets.has(mount.target)) continue;
    const fact: ObservedMount = {
      type: "volume",
      source: mount.store,
      target: mount.target,
      readOnly: mount.readOnly,
    };
    planned.push({ fact, realized: fact, lifetime: "retained" });
  }
  const observed = observation?.status === "present" ? observation.mounts : [];
  const matched = new Set<ObservedMount>();
  const result = planned.map(({ fact, realized, lifetime }): ServiceInfoMount => {
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
