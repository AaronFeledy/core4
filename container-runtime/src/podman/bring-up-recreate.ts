import { ServiceRestartWouldRecreateError } from "@lando/sdk/errors";
import { AGENT_SOCKET_CONTAINER_DIR, type AppPlan, type ServicePlan } from "@lando/sdk/schema";

import { fingerprintPlannedPublishPorts } from "../plan.ts";
import { podmanNetworkNames } from "./networks.ts";

export type BringUpRecreateReason = "publish-port" | "bind-source" | "network";

export interface BringUpInspectSnapshot {
  readonly publishFingerprint?: string | undefined;
  readonly bindSources?: Readonly<Record<string, string>> | ReadonlyMap<string, string> | undefined;
  readonly networkNames?: ReadonlyArray<string> | ReadonlySet<string> | undefined;
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

export const bindSourceChanged = (service: ServicePlan, inspected: BringUpInspectSnapshot): boolean => {
  const source = sourceLookup(inspected.bindSources);
  for (const target of Object.values(AGENT_SOCKET_CONTAINER_DIR)) {
    const agentMount = service.mounts.find((mount) => mount.target === target);
    const agentSource = agentMount === undefined ? undefined : `${agentMount.type}:${agentMount.source}`;
    if (agentSource !== source(target)) return true;
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
  if (!skipAbsent || inspected.networkNames !== undefined) {
    if (plannedNetworkMissing(plan, inspected)) reasons.push("network");
  }
  return reasons;
};

const recreateMessage = (service: string, reason: ServiceRestartWouldRecreateError["reason"]): string => {
  switch (reason) {
    case "publish-port":
      return `Restarting ${service} would recreate it because its published ports no longer match the running container.`;
    case "bind-source":
      return `Restarting ${service} would recreate it because a bind mount source changed.`;
    case "network":
      return `Restarting ${service} would recreate it because a planned network is missing.`;
    case "host-port":
      return `Restarting ${service} would recreate it because its assigned host port is already in use.`;
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
    message: recreateMessage(input.service, input.reason),
    remediation: serviceRestartRebuildHint(input.service),
  });
