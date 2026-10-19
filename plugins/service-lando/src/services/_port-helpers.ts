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

export const listenPort = (
  service: ServiceConfig,
  serviceName: string,
  listener: { readonly port: number; readonly variable?: string; readonly daemon: string },
): number => {
  const variable = listener.variable;
  const authored = variable === undefined ? undefined : service.environment?.[variable];
  if (authored === undefined) return service.port ?? listener.port;
  const parsed = /^[0-9]+$/.test(authored) ? Number(authored) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      `services.${serviceName}.environment.${variable} must be a TCP port number, got ${JSON.stringify(authored)}. Set port: instead, or fix ${variable}.`,
    );
  }
  if (service.port !== undefined && service.port !== parsed) {
    throw new Error(
      `services.${serviceName} sets port: ${service.port} and environment.${variable}: ${authored}. ${listener.daemon} listens on ${variable}, so remove one or make them match.`,
    );
  }
  return parsed;
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
