import { Schema } from "effect";

import { BindAddress, type EndpointPublication, PortNumber } from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";

export type ParsedPort = {
  readonly port: PortNumber;
  readonly protocol: "tcp" | "udp";
  readonly bindAddress?: BindAddress;
  readonly hostPort?: PortNumber;
};

const parsePortNumber = (value: string, entry: string): PortNumber => {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`Invalid port "${entry}".`);
  return Schema.decodeUnknownSync(PortNumber)(Number(value));
};

const optionalHostPort = (value: string, entry: string): PortNumber | undefined =>
  value.length === 0 ? undefined : parsePortNumber(value, entry);

/**
 * Parse a Compose-style port spec `[<host-ip>:][<host-port>:]<container-port>[/<proto>]`.
 * An omitted host port (container-only `"8080"` or dynamic `"127.0.0.1::80"`) leaves
 * `hostPort` undefined so the provider assigns it. IPv6 host IPs are bracketed
 * (`[::1]::80`). Only `tcp`/`udp` are accepted; any other protocol throws.
 */
export const parsePublishedPort = (entry: string): ParsedPort => {
  const protocolParts = entry.split("/");
  if (
    protocolParts.length > 2 ||
    (protocolParts[1] !== undefined && protocolParts[1] !== "tcp" && protocolParts[1] !== "udp")
  ) {
    throw new Error(`Invalid port protocol in "${entry}". Allowed: tcp, udp.`);
  }
  const portSpec = protocolParts[0];
  if (portSpec === undefined) throw new Error(`Invalid port entry "${entry}".`);
  const protocol = protocolParts[1] === "udp" ? "udp" : "tcp";
  const targetSeparator = portSpec.lastIndexOf(":");
  const port = parsePortNumber(
    targetSeparator === -1 ? portSpec : portSpec.slice(targetSeparator + 1),
    entry,
  );
  if (targetSeparator === -1) return { port, protocol };

  const hostSpec = portSpec.slice(0, targetSeparator);
  const hostSeparator = hostSpec.lastIndexOf(":");
  if (hostSeparator === -1) {
    const hostPort = optionalHostPort(hostSpec, entry);
    return { port, protocol, ...(hostPort === undefined ? {} : { hostPort }) };
  }
  const hostPort = optionalHostPort(hostSpec.slice(hostSeparator + 1), entry);
  const encodedBind = hostSpec.slice(0, hostSeparator);
  const bind =
    encodedBind.startsWith("[") && encodedBind.endsWith("]") ? encodedBind.slice(1, -1) : encodedBind;
  return {
    port,
    protocol,
    bindAddress: Schema.decodeUnknownSync(BindAddress)(bind),
    ...(hostPort === undefined ? {} : { hostPort }),
  };
};

export const publicationFor = (parsed: ParsedPort): typeof EndpointPublication.Type => ({
  ...(parsed.bindAddress === undefined ? {} : { bindAddress: parsed.bindAddress }),
  ...(parsed.hostPort === undefined ? {} : { hostPort: parsed.hostPort }),
});

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

  for (const entry of configured) {
    const parsed = parsePublishedPort(entry);
    ctx.addEndpoint({
      _tag: "published",
      port: parsed.port,
      protocol: parsed.protocol === "udp" ? "udp" : fallback.protocol,
      name: ctx.serviceName,
      publication: publicationFor(parsed),
    });
  }
};
