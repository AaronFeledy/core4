import { createSocket } from "node:dgram";
import { createServer } from "node:net";

import { Effect } from "effect";

import { errnoCode, isErrnoCode } from "@lando/sdk/errors";
import {
  DEFAULT_ROUTER_HTTPS_PORTS,
  DEFAULT_ROUTER_HTTP_PORTS,
  type EndpointPlan,
  type HostPlatform,
  type ObservedPublication,
  PortNumber,
  type PublishedEndpoint,
  hostPlatformFamily,
} from "@lando/sdk/schema";

import type { EngineHttpResponse } from "./engine-api.ts";
import { matchPublicationBindings, physicalPublicationIdentity } from "./physical-publications.ts";
import { publicationObservationFromInspect } from "./podman/inspect.ts";

/**
 * Host ports for unpinned service publication. Stays off the router try-lists
 * (80/443, the 8080/8443 ladders including 38080/38443, and the win32 extras)
 * and below the host ephemeral range (32768+).
 */
export const SERVICE_PUBLISH_PORT_MIN = 30_000;
export const SERVICE_PUBLISH_PORT_MAX = 32_767;

/** Router and helper ladders that this band must never overlap. */
export const SERVICE_PUBLISH_RESERVED_PORTS = new Set<number>([
  ...DEFAULT_ROUTER_HTTP_PORTS,
  ...DEFAULT_ROUTER_HTTPS_PORTS,
  38_080,
  48_080,
  58_080,
  38_443,
  48_443,
  58_443,
  48_081,
  58_081,
  48_082,
  58_082,
  48_444,
  58_444,
  48_445,
  58_445,
]);

export type ServicePublishHostKind = "local" | "remote-url" | "vm-mediated-docker" | "win32-guest";

export interface ServicePublishHost {
  readonly kind: ServicePublishHostKind;
}

export type ServicePublishBindOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "EADDRINUSE"; readonly code: "EADDRINUSE" }
  | { readonly kind: "EACCES"; readonly code: "EACCES" | "EPERM" }
  | { readonly kind: "other-error"; readonly code?: string };

export type ServicePublishProbe = (
  host: string,
  port: number,
  protocol: "tcp" | "udp",
) => Effect.Effect<ServicePublishBindOutcome>;

const classifyBindError = (error: unknown): ServicePublishBindOutcome => {
  if (isErrnoCode(error, "EADDRINUSE")) return { kind: "EADDRINUSE", code: "EADDRINUSE" };
  if (isErrnoCode(error, "EACCES")) return { kind: "EACCES", code: "EACCES" };
  if (isErrnoCode(error, "EPERM")) return { kind: "EACCES", code: "EPERM" };
  const code = errnoCode(error);
  return { kind: "other-error", ...(code === undefined ? {} : { code }) };
};

const listenTcp = (host: string, port: number): Promise<ServicePublishBindOutcome> =>
  new Promise((resolve) => {
    const server = createServer();
    const finish = (outcome: ServicePublishBindOutcome) => {
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(outcome));
        return;
      }
      resolve(outcome);
    };
    server.once("error", (error) => finish(classifyBindError(error)));
    server.listen(port, host, () => finish({ kind: "success" }));
  });

const bindUdp = (host: string, port: number): Promise<ServicePublishBindOutcome> =>
  new Promise((resolve) => {
    const socket = createSocket(host.includes(":") ? "udp6" : "udp4");
    const finish = (outcome: ServicePublishBindOutcome) => {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(outcome);
    };
    socket.once("error", (error) => finish(classifyBindError(error)));
    socket.bind(port, host, () => finish({ kind: "success" }));
  });

/** Listen then close. A TCP listen does not speak for a udp endpoint. */
export const probeServicePublishBind: ServicePublishProbe = (host, port, protocol) =>
  Effect.promise(() => (protocol === "udp" ? bindUdp(host, port) : listenTcp(host, port)));

const asHostPlatform = (platform: string | undefined): HostPlatform | undefined => {
  if (platform === "darwin" || platform === "linux" || platform === "win32" || platform === "wsl") {
    return platform;
  }
  return undefined;
};

const isRemoteDaemonUrl = (daemonUrl: string | undefined): boolean =>
  daemonUrl !== undefined && /^(?:tcp|http|https):\/\//u.test(daemonUrl);

const isDockerDesktopSocket = (daemonUrl: string | undefined): boolean => {
  if (daemonUrl === undefined) return false;
  const socketPath = daemonUrl.startsWith("unix://") ? daemonUrl.slice("unix://".length) : daemonUrl;
  return socketPath.includes("/.docker/desktop/") || socketPath.includes("/.docker/run/");
};

export const classifyServicePublishHost = (input: {
  readonly platform?: string;
  readonly daemonUrl?: string;
}): ServicePublishHost => {
  const platform = asHostPlatform(input.platform);
  const family = platform === undefined ? undefined : hostPlatformFamily(platform);
  if (family === "win32") return { kind: "win32-guest" };
  if (isRemoteDaemonUrl(input.daemonUrl)) return { kind: "remote-url" };
  if (family === "darwin" || isDockerDesktopSocket(input.daemonUrl)) return { kind: "vm-mediated-docker" };
  return { kind: "local" };
};

export const shouldProbeServicePublishPort = (host: ServicePublishHost): boolean => host.kind === "local";

const publishTransport = (endpoint: PublishedEndpoint): "tcp" | "udp" =>
  endpoint.protocol === "udp" ? "udp" : "tcp";

const inspectPublicationBindings = (inspect: unknown): readonly ObservedPublication[] => {
  const observation = publicationObservationFromInspect(inspect);
  const network = observation.status === "present" ? observation.bindings : [];
  if (typeof inspect !== "object" || inspect === null || !("HostConfig" in inspect)) return network;
  const hostConfig = inspect.HostConfig;
  if (typeof hostConfig !== "object" || hostConfig === null || !("PortBindings" in hostConfig))
    return network;
  const configured = publicationObservationFromInspect({
    NetworkSettings: { Ports: hostConfig.PortBindings },
  });
  return configured.status === "present" ? [...network, ...configured.bindings] : network;
};

export const inspectHostPortForEndpoint = (
  inspect: unknown,
  endpoint: PublishedEndpoint,
): number | undefined =>
  matchPublicationBindings([endpoint], inspectPublicationBindings(inspect)).get(
    physicalPublicationIdentity(endpoint),
  )?.[0]?.hostPort;

const withHostPort = (endpoint: PublishedEndpoint, hostPort: number): PublishedEndpoint => ({
  ...endpoint,
  publication: { ...endpoint.publication, hostPort: PortNumber.make(hostPort) },
});

export const copyInspectHostPorts = (
  endpoints: ReadonlyArray<EndpointPlan>,
  inspect: unknown,
): ReadonlyArray<EndpointPlan> => {
  const matches = matchPublicationBindings(endpoints, inspectPublicationBindings(inspect));
  return endpoints.map((endpoint) => {
    if (endpoint._tag !== "published" || endpoint.publication.hostPort !== undefined) return endpoint;
    const hostPort = matches.get(physicalPublicationIdentity(endpoint))?.[0]?.hostPort;
    return hostPort === undefined ? endpoint : withHostPort(endpoint, hostPort);
  });
};

const assignedHostPorts = (endpoints: ReadonlyArray<EndpointPlan>): ReadonlySet<number> => {
  const ports = new Set<number>();
  for (const endpoint of endpoints) {
    if (endpoint._tag !== "published") continue;
    const hostPort = endpoint.publication.hostPort;
    if (hostPort !== undefined) ports.add(hostPort);
  }
  return ports;
};

const walkServicePublishBand = Effect.fnUntraced(function* (
  host: string,
  protocol: "tcp" | "udp",
  reserved: ReadonlySet<number>,
  probe: ServicePublishProbe,
): Effect.fn.Return<number | undefined> {
  for (let port = SERVICE_PUBLISH_PORT_MIN; port <= SERVICE_PUBLISH_PORT_MAX; port += 1) {
    if (reserved.has(port) || SERVICE_PUBLISH_RESERVED_PORTS.has(port)) continue;
    const outcome = yield* probe(host, port, protocol);
    if (outcome.kind === "success" || outcome.kind === "EACCES") return port;
    if (outcome.kind === "EADDRINUSE" || outcome.kind === "other-error") continue;
  }
  return undefined;
});

export const probeUnpinnedServicePublishPorts = Effect.fnUntraced(function* (
  endpoints: ReadonlyArray<EndpointPlan>,
  options: {
    readonly probeBind?: ServicePublishProbe;
    readonly exclude?: ReadonlySet<number>;
  } = {},
): Effect.fn.Return<ReadonlyArray<EndpointPlan>> {
  const probe = options.probeBind ?? probeServicePublishBind;
  const reserved = new Set<number>([...(options.exclude ?? []), ...assignedHostPorts(endpoints)]);
  const assigned: EndpointPlan[] = [];
  const allocations = new Map<string, number>();
  for (const endpoint of endpoints) {
    if (endpoint._tag !== "published" || endpoint.publication.hostPort !== undefined) {
      assigned.push(endpoint);
      continue;
    }
    const bindAddress = endpoint.publication.bindAddress ?? "127.0.0.1";
    const identity = physicalPublicationIdentity(endpoint);
    const allocation = allocations.get(identity);
    if (allocation !== undefined) {
      assigned.push(withHostPort(endpoint, allocation));
      continue;
    }
    const port = yield* walkServicePublishBand(bindAddress, publishTransport(endpoint), reserved, probe);
    if (port === undefined) {
      assigned.push(endpoint);
      continue;
    }
    reserved.add(port);
    allocations.set(identity, port);
    assigned.push(withHostPort(endpoint, port));
  }
  return assigned;
});

export const prepareCreatePublishEndpoints = Effect.fnUntraced(function* (input: {
  readonly endpoints: ReadonlyArray<EndpointPlan>;
  readonly inspect?: unknown;
  readonly copyInspectHostPort: boolean;
  readonly host: ServicePublishHost;
  readonly probeBind?: ServicePublishProbe;
  readonly exclude?: ReadonlySet<number>;
}): Effect.fn.Return<ReadonlyArray<EndpointPlan>> {
  const copied =
    input.copyInspectHostPort && input.inspect !== undefined
      ? copyInspectHostPorts(input.endpoints, input.inspect)
      : input.endpoints;
  if (!shouldProbeServicePublishPort(input.host)) return copied;
  return yield* probeUnpinnedServicePublishPorts(copied, {
    ...(input.probeBind === undefined ? {} : { probeBind: input.probeBind }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
  });
});

/** Classifies daemon host-port bind rejections during container create or start. */
export const isHostPortBindRejection = (response: EngineHttpResponse): boolean =>
  response.status >= 400 &&
  (/address already in use/iu.test(response.body) ||
    /port is already allocated/iu.test(response.body) ||
    /bind:.*in use/iu.test(response.body) ||
    /EADDRINUSE/u.test(response.body));

export const createAssignedHostPorts = (endpoints: ReadonlyArray<EndpointPlan>): ReadonlySet<number> =>
  assignedHostPorts(endpoints);
