import { ServiceRestartWouldRecreateError } from "@lando/sdk/errors";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { CREATE_CONFIG_LABEL } from "../create-fingerprint.ts";
import { HOST_PROXY_SESSION_LABEL } from "../labels.ts";
import { commonContainerLabels, fingerprintPlannedPublishPorts } from "../plan.ts";
import { podmanNetworkNames } from "./networks.ts";

// Private SSH sidecar protocol: the optional POSIX host socket bind endpoint.
const SSH_SIDECAR_HOST_SOCKET_DIRECTORY = "/ssh-auth";

export type BringUpRecreateReason = "publish-port" | "bind-source" | "network" | "config";

export interface BringUpInspectSnapshot {
  readonly publishFingerprint?: string | undefined;
  readonly bindSources?: Readonly<Record<string, string>> | ReadonlyMap<string, string> | undefined;
  readonly networkNames?: ReadonlyArray<string> | ReadonlySet<string> | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
}

const sourceLookup = (
  sources: BringUpInspectSnapshot["bindSources"],
): ((target: string) => string | undefined) => {
  if (sources === undefined) return () => undefined;
  if (sources instanceof Map) return (target) => sources.get(target);
  return (target) => {
    const value = Reflect.get(sources, target);
    return typeof value === "string" ? value : undefined;
  };
};

const networkLookup = (names: BringUpInspectSnapshot["networkNames"]): ReadonlySet<string> | undefined => {
  if (names === undefined) return undefined;
  return names instanceof Set ? names : new Set(names);
};

export const inspectBindSources = (body: unknown): Readonly<Record<string, string>> | undefined => {
  const sources: Record<string, string> = {};
  if (typeof body !== "object" || body === null) return undefined;
  const mounts = Reflect.get(body, "Mounts");
  if (!Array.isArray(mounts)) return undefined;
  for (const mount of mounts) {
    if (typeof mount !== "object" || mount === null) continue;
    const target = Reflect.get(mount, "Destination");
    const type = Reflect.get(mount, "Type");
    if (
      (target === AGENT_SOCKET_CONTAINER_DIR.ssh || target === AGENT_SOCKET_CONTAINER_DIR.gpg) &&
      typeof type === "string"
    ) {
      const source = Reflect.get(mount, type === "volume" ? "Name" : "Source");
      if (typeof source === "string") sources[target] = `${type}:${source}`;
      continue;
    }
    if (type !== "bind") continue;
    const source = Reflect.get(mount, "Source");
    if (typeof target === "string" && typeof source === "string") sources[target] = source;
  }
  return sources;
};

export const inspectNetworkNames = (body: unknown): ReadonlyArray<string> | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const settings = Reflect.get(body, "NetworkSettings");
  if (typeof settings !== "object" || settings === null) return undefined;
  const networks = Reflect.get(settings, "Networks");
  if (typeof networks !== "object" || networks === null || Array.isArray(networks)) return undefined;
  return Object.keys(networks);
};

export const inspectContainerLabels = (body: unknown): Readonly<Record<string, string>> => {
  if (typeof body !== "object" || body === null) return {};
  const config: unknown = Reflect.get(body, "Config");
  if (typeof config !== "object" || config === null) return {};
  const labels: unknown = Reflect.get(config, "Labels");
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

/** Present logical evidence only after verifying the full physical create configuration. */
export const presentLogicalCreateConfig = (
  labels: Readonly<Record<string, string>>,
  plans: { readonly physical: AppPlan; readonly logical: AppPlan; readonly service: ServiceName },
): Readonly<Record<string, string>> => {
  const physicalService = plans.physical.services[plans.service];
  const logicalService = plans.logical.services[plans.service];
  if (physicalService === undefined || logicalService === undefined) return labels;
  const physicalExpected = commonContainerLabels(plans.physical, physicalService)[CREATE_CONFIG_LABEL];
  const logicalExpected = commonContainerLabels(plans.logical, logicalService)[CREATE_CONFIG_LABEL];
  if (
    physicalExpected === undefined ||
    logicalExpected === undefined ||
    labels[CREATE_CONFIG_LABEL] === undefined
  ) {
    return labels;
  }
  if (labels[CREATE_CONFIG_LABEL] !== physicalExpected) {
    if (physicalExpected === logicalExpected) return labels;
    return Object.fromEntries(Object.entries(labels).filter(([key]) => key !== CREATE_CONFIG_LABEL));
  }
  return {
    ...labels,
    [CREATE_CONFIG_LABEL]: logicalExpected,
  };
};

export const bindSourceChanged = (service: ServicePlan, inspected: BringUpInspectSnapshot): boolean => {
  const source = sourceLookup(inspected.bindSources);
  for (const target of Object.values(AGENT_SOCKET_CONTAINER_DIR)) {
    const agentMount = service.mounts.find((mount) => mount.target === target);
    // Global sidecars declare socket volumes as storage; app overlays use mounts.
    const agentStorage = service.storage.find((mount) => mount.target === target);
    const agentSource =
      agentMount !== undefined
        ? `${agentMount.type}:${agentMount.source}`
        : agentStorage === undefined
          ? undefined
          : `volume:${agentStorage.store}`;
    if (agentSource !== source(target)) return true;
  }
  if (service.storage.some((mount) => mount.target === AGENT_SOCKET_CONTAINER_DIR.ssh)) {
    const hostSocketMount = service.mounts.find(
      (mount) => mount.target === SSH_SIDECAR_HOST_SOCKET_DIRECTORY,
    );
    if (hostSocketMount?.source !== source(SSH_SIDECAR_HOST_SOCKET_DIRECTORY)) return true;
  }
  const socketTarget = service.environment.LANDO_HOST_PROXY_SOCKET;
  if (socketTarget === undefined) return false;
  const plannedSocket = service.mounts.find(
    (mount) => mount.type === "bind" && mount.realization === "passthrough" && mount.target === socketTarget,
  );
  return plannedSocket?.source !== undefined && source(socketTarget) !== plannedSocket.source;
};

export const plannedNetworkMissing = (plan: AppPlan, inspected: BringUpInspectSnapshot): boolean => {
  const names = networkLookup(inspected.networkNames);
  return names !== undefined && podmanNetworkNames(plan).some((name) => !names.has(name));
};

export const publishPortMismatch = (plan: ServicePlan, inspected: BringUpInspectSnapshot): boolean => {
  const published = plan.endpoints.flatMap((endpoint) => (endpoint._tag === "published" ? [endpoint] : []));
  const plannedFingerprint = fingerprintPlannedPublishPorts(published);
  const inspectFingerprint = inspected.publishFingerprint ?? "";
  return (
    plannedFingerprint.length > 0 &&
    inspectFingerprint.length > 0 &&
    inspectFingerprint !== plannedFingerprint
  );
};

export const bringUpRecreateReasons = (
  plan: AppPlan,
  service: ServicePlan,
  inspected: BringUpInspectSnapshot,
  options: { readonly skipAbsentFields?: boolean } = {},
): ReadonlyArray<BringUpRecreateReason> => {
  const skipAbsent = options.skipAbsentFields === true;
  const reasons: BringUpRecreateReason[] = [];
  if (!skipAbsent || inspected.publishFingerprint !== undefined) {
    if (publishPortMismatch(service, inspected)) reasons.push("publish-port");
  }
  if (!skipAbsent || inspected.bindSources !== undefined) {
    if (bindSourceChanged(service, inspected)) reasons.push("bind-source");
  }
  if (
    service.environment.LANDO_HOST_PROXY_SESSION !== undefined &&
    (!skipAbsent || inspected.labels !== undefined)
  ) {
    if (
      inspected.labels?.[HOST_PROXY_SESSION_LABEL] !==
        commonContainerLabels(plan, service)[HOST_PROXY_SESSION_LABEL] &&
      !reasons.includes("bind-source")
    )
      reasons.push("bind-source");
  }
  if (!skipAbsent || inspected.networkNames !== undefined) {
    if (plannedNetworkMissing(plan, inspected)) reasons.push("network");
  }
  if (!skipAbsent || inspected.labels !== undefined) {
    if (
      inspected.labels?.[CREATE_CONFIG_LABEL] !== commonContainerLabels(plan, service)[CREATE_CONFIG_LABEL]
    ) {
      reasons.push("config");
    }
  }
  return reasons;
};

const recreateMessage = (
  service: string,
  reason: ServiceRestartWouldRecreateError["reason"],
  operation: string,
): string => {
  switch (reason) {
    case "publish-port":
      return `Restarting ${service} would recreate it because its published ports no longer match the running container.`;
    case "bind-source":
      return `Restarting ${service} would recreate it because a bind mount source changed.`;
    case "network":
      return `Restarting ${service} would recreate it because a planned network is missing.`;
    case "config":
      return `Restarting ${service} would recreate it because its create configuration changed.`;
    case "host-port":
      return operation === "bringUp.start"
        ? `${service} was stopped and is still down because its assigned host port is already in use. Run \`lando rebuild -s ${service}\`.`
        : `Restarting ${service} would recreate it because its assigned host port is already in use.`;
  }
};

export const serviceRestartRebuildHint = (service: string): string =>
  `Run \`lando rebuild -s ${service}\` to recreate this service.`;

export const makeServiceRestartWouldRecreateError = (input: {
  readonly providerId: string;
  readonly service: string;
  readonly reason: ServiceRestartWouldRecreateError["reason"];
  readonly operation?: string;
}): ServiceRestartWouldRecreateError =>
  new ServiceRestartWouldRecreateError({
    providerId: input.providerId,
    operation: input.operation ?? "restart",
    service: input.service,
    reason: input.reason,
    message: recreateMessage(input.service, input.reason, input.operation ?? "restart"),
    remediation: serviceRestartRebuildHint(input.service),
  });
