import type { BindAddress, EndpointPlan, PortNumber, PublishedEndpoint } from "@lando/sdk/schema";

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
  if (address === "127.0.0.1" || address === "0.0.0.0") return "localhost";
  return address.includes(":") ? `[${address}]` : address;
};

export const publishedEndpointUrl = (
  endpoint: MaterializedPublishedEndpoint,
  scheme: string = endpoint.protocol,
): string | undefined => {
  const hostPort = publishedEndpointHostPort(endpoint);
  return hostPort === undefined ? undefined : `${scheme}://${publishedEndpointHost(endpoint)}:${hostPort}`;
};

export const publishedEndpointUrls = (endpoints: ReadonlyArray<EndpointPlan>): ReadonlyArray<string> =>
  endpoints.flatMap((endpoint) => {
    if (endpoint._tag === "internal") return [];
    const url = publishedEndpointUrl(endpoint);
    return url === undefined ? [] : [url];
  });
