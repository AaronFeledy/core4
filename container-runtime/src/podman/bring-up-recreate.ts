import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type BindMountPlan,
  type ServicePlan,
  landoServiceNetworkAttachments,
} from "@lando/sdk/schema";

import { CREATE_CONFIG_LABEL } from "../create-fingerprint.ts";
import { HOST_PROXY_SESSION_LABEL, hostProxySessionDigest } from "../labels.ts";
import { commonContainerLabels, fingerprintPlannedPublishPorts } from "../plan.ts";

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

export const bindSourceChanged = (service: ServicePlan, inspected: BringUpInspectSnapshot): boolean => {
  const source = sourceLookup(inspected.bindSources);
  for (const target of Object.values(AGENT_SOCKET_CONTAINER_DIR)) {
    const agentMount = service.mounts.find((mount) => mount.target === target);
    let agentSource: string | undefined;
    if (agentMount !== undefined) {
      switch (agentMount.type) {
        case "bind":
          agentSource = `bind:${agentMount.source}`;
          break;
        case "volume":
          agentSource = `volume:${agentMount.store}`;
          break;
        case "tmpfs":
          agentSource = "tmpfs:";
          break;
        default:
          agentMount satisfies never;
      }
    }
    if (agentSource !== source(target)) return true;
  }
  if (
    service.mounts.some((mount) => mount.type === "volume" && mount.target === AGENT_SOCKET_CONTAINER_DIR.ssh)
  ) {
    const hostSocketMount = service.mounts.find(
      (mount): mount is BindMountPlan =>
        mount.type === "bind" && mount.target === SSH_SIDECAR_HOST_SOCKET_DIRECTORY,
    );
    if (hostSocketMount?.source !== source(SSH_SIDECAR_HOST_SOCKET_DIRECTORY)) return true;
  }
  if (hostProxySessionDigest(service.extensions) === undefined) return false;
  return ["/run/lando/host-proxy.sock", "/run/lando/host-proxy/credentials"].some((target) => {
    const planned = service.mounts.find(
      (mount): mount is BindMountPlan =>
        mount.type === "bind" && mount.realization === "passthrough" && mount.target === target,
    );
    return planned !== undefined && source(target) !== planned.source;
  });
};

export const plannedNetworkMissing = (
  plan: AppPlan,
  service: ServicePlan,
  inspected: BringUpInspectSnapshot,
): boolean => {
  const names = networkLookup(inspected.networkNames);
  return (
    names !== undefined && landoServiceNetworkAttachments(plan, service).some(({ name }) => !names.has(name))
  );
};

export const publishPortMismatch = (plan: ServicePlan, inspected: BringUpInspectSnapshot): boolean => {
  const published = plan.endpoints.flatMap((endpoint) => (endpoint.kind === "published" ? [endpoint] : []));
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
): ReadonlyArray<BringUpRecreateReason> => {
  const reasons: BringUpRecreateReason[] = [];
  if (publishPortMismatch(service, inspected)) reasons.push("publish-port");
  const expectedLabels = commonContainerLabels(plan, service);
  if (
    bindSourceChanged(service, inspected) ||
    (hostProxySessionDigest(service.extensions) !== undefined &&
      inspected.labels?.[HOST_PROXY_SESSION_LABEL] !== expectedLabels[HOST_PROXY_SESSION_LABEL])
  ) {
    reasons.push("bind-source");
  }
  if (plannedNetworkMissing(plan, service, inspected)) reasons.push("network");
  if (inspected.labels?.[CREATE_CONFIG_LABEL] !== expectedLabels[CREATE_CONFIG_LABEL]) {
    reasons.push("config");
  }
  return reasons;
};
