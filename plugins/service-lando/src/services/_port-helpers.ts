import { Schema } from "effect";

import {
  type ComposePortEntry,
  type EndpointPublication,
  type InternalEndpointInput,
  PortNumber,
  type PublishedEndpointInput,
  type ServiceConfig,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";

interface Listener {
  readonly port: number;
  readonly variable?: string;
  readonly daemon: string;
  readonly reserved?: readonly { readonly port: number; readonly use: string }[];
}

export const plannedPort = (service: ServiceConfig, listener: Listener): number =>
  service.port ?? listener.port;

export const assertListenerConfig = (
  service: ServiceConfig,
  serviceName: string,
  listener: Listener,
): void => {
  const port = plannedPort(service, listener);
  const variable = listener.variable;
  const authored = variable === undefined ? undefined : service.environment?.[variable];
  if (authored !== undefined) {
    const value = /^[0-9]+$/.test(authored) ? Number(authored) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(
        `services.${serviceName}.environment.${variable} is ${JSON.stringify(authored)}, which is not a TCP port number. Remove it and set port: instead; Lando sets ${variable} from port:.`,
      );
    }
    if (value !== port) {
      const reservedValue = listener.reserved?.find((entry) => entry.port === value);
      throw new Error(
        reservedValue === undefined
          ? `services.${serviceName}.environment.${variable} is ${authored}, but the service listens on ${port}. Set port: ${value} instead; Lando sets ${variable} from port:.`
          : `services.${serviceName}.environment.${variable} is ${authored}, which ${listener.daemon} reserves for its ${reservedValue.use}. Remove it and set port: to another TCP port number; Lando sets ${variable} from port:.`,
      );
    }
  }
  const reserved = listener.reserved?.find((entry) => entry.port === port);
  if (reserved !== undefined) {
    throw new Error(
      `services.${serviceName}.port plans ${listener.daemon} on port ${port}, which ${listener.daemon} reserves for its ${reserved.use}. Set port: to another TCP port number.`,
    );
  }
};

const publicationFor = (entry: ComposePortEntry): typeof EndpointPublication.Type => ({
  ...(entry.hostIp === undefined ? {} : { bindAddress: entry.hostIp }),
  ...(entry.published === undefined ? {} : { hostPort: entry.published }),
});

export const publishedEndpointsFromPorts = (
  entries: readonly ComposePortEntry[],
  fallbackProtocol?: "http" | "https" | "tcp",
): readonly PublishedEndpointInput[] =>
  entries.map((entry) => ({
    _tag: "published",
    port: entry.target,
    protocol: entry.protocol === "udp" ? "udp" : (fallbackProtocol ?? "tcp"),
    publication: publicationFor(entry),
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.appProtocol === undefined ? {} : { appProtocol: entry.appProtocol }),
  }));

export const internalEndpointsFromExpose = (
  targets: readonly PortNumber[],
  protocol: "http" | "https" | "tcp",
): readonly InternalEndpointInput[] => targets.map((port) => ({ _tag: "internal", port, protocol }));

export const addServicePortEndpoints = (
  ctx: ServiceFeatureContext,
  fallback: { readonly port: number; readonly protocol: "http" | "https" | "tcp" },
): void => {
  const configured = ctx.normalizedConfig.ports;
  if (configured === undefined) {
    ctx.addEndpoint({
      _tag: "internal",
      port: Schema.decodeUnknownSync(PortNumber)(fallback.port),
      protocol: fallback.protocol,
      name: ctx.serviceName,
    });
    return;
  }

  for (const endpoint of publishedEndpointsFromPorts(configured, fallback.protocol)) {
    ctx.addEndpoint(endpoint);
  }
};
