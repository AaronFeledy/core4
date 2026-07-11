import { type AppPlan, PortablePath, type ServicePlan } from "@lando/sdk/schema";

import type { HostProxyRunLandoConnectionSession } from "./transport-protocol.ts";
import type { HostProxyTransportKind } from "./transport.ts";

export const HOST_PROXY_CONTAINER_SOCKET = "/run/lando/host-proxy.sock";
export const HOST_PROXY_CONTAINER_SHIM = "/usr/local/lib/lando/host-proxy-client";
export const HOST_PROXY_CONTAINER_LANDO = "/usr/local/bin/lando";
export const HOST_PROXY_TRANSPORT_EXTENSION_KEY = "@lando/core/host-proxy-transport";

export interface HostProxyRunLandoFeatureSession extends HostProxyRunLandoConnectionSession {
  readonly shimPath: string;
  readonly transport?: HostProxyTransportKind;
  readonly containerUrl?: string;
}

interface HostProxyRunLandoFeatureMutators {
  addEnv(name: string, value: string): void;
  addMount(mount: {
    readonly type: "bind";
    readonly source: string;
    readonly target: typeof PortablePath.Type;
    readonly readOnly: boolean;
    readonly realization: "passthrough";
  }): void;
  addExtension?(name: string, value: unknown): void;
}

export const hostProxyRunLandoFeature = (session: HostProxyRunLandoFeatureSession) => ({
  apply: (service: HostProxyRunLandoFeatureMutators): void => {
    const transport = session.transport ?? "unix-socket";
    service.addEnv("LANDO_HOST_PROXY_TRANSPORT", transport);
    if (transport === "tcp-host-gateway") {
      const containerUrl = session.containerUrl ?? session.url;
      if (containerUrl !== undefined) service.addEnv("LANDO_HOST_PROXY_URL", containerUrl);
    } else {
      if (session.socketPath === undefined) return;
      service.addEnv("LANDO_HOST_PROXY_SOCKET", HOST_PROXY_CONTAINER_SOCKET);
      service.addMount({
        type: "bind",
        source: session.socketPath,
        target: PortablePath.make(HOST_PROXY_CONTAINER_SOCKET),
        readOnly: true,
        realization: "passthrough",
      });
    }
    service.addEnv("LANDO_HOST_PROXY_TOKEN", session.token);
    service.addEnv("LANDO_HOST_PROXY_SESSION", session.sessionId);
    service.addEnv("LANDO_HOST_PROXY_APP", session.appId);
    service.addEnv("LANDO_HOST_PROXY_DEPTH", "0");
    service.addMount({
      type: "bind",
      source: session.shimPath,
      target: PortablePath.make(HOST_PROXY_CONTAINER_SHIM),
      readOnly: true,
      realization: "passthrough",
    });
    service.addMount({
      type: "bind",
      source: session.shimPath,
      target: PortablePath.make(HOST_PROXY_CONTAINER_LANDO),
      readOnly: true,
      realization: "passthrough",
    });
  },
});

/**
 * Env names the runLando feature injects into eligible services. These carry
 * per-session authentication and transport material, so they are stripped
 * from persisted plans and never forwarded back into host command env.
 */
export const HOST_PROXY_RUN_LANDO_ENV_NAMES: ReadonlyArray<string> = [
  "LANDO_HOST_PROXY_TRANSPORT",
  "LANDO_HOST_PROXY_SOCKET",
  "LANDO_HOST_PROXY_URL",
  "LANDO_HOST_PROXY_TOKEN",
  "LANDO_HOST_PROXY_SESSION",
  "LANDO_HOST_PROXY_APP",
  "LANDO_HOST_PROXY_DEPTH",
  "LANDO_HOST_PROXY_SHIM",
];

export const isHostProxyRunLandoEnvName = (name: string): boolean =>
  HOST_PROXY_RUN_LANDO_ENV_NAMES.includes(name);

const HOST_PROXY_MOUNT_TARGETS: ReadonlySet<string> = new Set([
  HOST_PROXY_CONTAINER_SOCKET,
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_CONTAINER_LANDO,
]);

const stripHostProxyService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: Object.fromEntries(
    Object.entries(service.environment).filter(([name]) => !isHostProxyRunLandoEnvName(name)),
  ),
  mounts: service.mounts.filter(
    (mount) => !(mount.type === "bind" && HOST_PROXY_MOUNT_TARGETS.has(mount.target)),
  ),
  extensions: Object.fromEntries(
    Object.entries(service.extensions).filter(([name]) => name !== HOST_PROXY_TRANSPORT_EXTENSION_KEY),
  ),
});

/**
 * Pure inverse of the `hostProxyRunLandoFeature` overlay: removes the
 * session-scoped env, socket/shim mounts, and transport extension so a plan
 * can be persisted or cached without live authentication material.
 */
export const stripHostProxyRunLando = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripHostProxyService(service)]),
  ),
});
