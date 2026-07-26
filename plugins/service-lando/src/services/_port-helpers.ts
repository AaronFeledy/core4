import { Schema } from "effect";

import {
  type ComposePortEntry,
  type EndpointPublication,
  type InternalEndpointInput,
  PortNumber,
  type PublishedEndpointInput,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";

export const publicationFor = (entry: ComposePortEntry): typeof EndpointPublication.Type => ({
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
    // Compose `ports` carry no endpoint-name intent. Keeping synthesized endpoints
    // unnamed avoids collisions when a service publishes several ports.
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
