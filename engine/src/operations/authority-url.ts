import type { BindAddress, PortNumber, PublishedEndpoint } from "@lando/sdk/schema";
import { connectionHost, connectionUrl } from "./connection-url.ts";

export type MaterializedPublishedEndpoint = PublishedEndpoint & {
  readonly materialization?: {
    readonly bindAddress: BindAddress;
    readonly hostPort: PortNumber;
  };
};

export const publishedEndpointHostPort = (endpoint: MaterializedPublishedEndpoint): PortNumber | undefined =>
  endpoint.materialization?.hostPort ?? endpoint.publication.hostPort;

export const publishedEndpointHost = (endpoint: MaterializedPublishedEndpoint): string => {
  const address = endpoint.materialization?.bindAddress ?? endpoint.publication.bindAddress ?? "127.0.0.1";
  const host = connectionHost(address);
  return host.includes(":") ? `[${host}]` : host;
};

export const publishedEndpointUrl = (
  endpoint: MaterializedPublishedEndpoint,
  scheme: string = endpoint.protocol,
): string | undefined => {
  const hostPort = publishedEndpointHostPort(endpoint);
  return hostPort === undefined
    ? undefined
    : connectionUrl({ host: publishedEndpointHost(endpoint), port: hostPort, protocol: scheme });
};
