import { PortablePath } from "@lando/sdk/schema";

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
