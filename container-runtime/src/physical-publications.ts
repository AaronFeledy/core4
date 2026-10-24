import type { EndpointPlan, ObservedPublication, PublishedEndpoint } from "@lando/sdk/schema";

export const physicalPublicationIdentity = (endpoint: PublishedEndpoint): string =>
  JSON.stringify([
    endpoint.port,
    endpoint.protocol === "udp" ? "udp" : "tcp",
    endpoint.publication.bindAddress ?? "127.0.0.1",
    endpoint.publication.hostPort ?? null,
  ]);

export const matchPublicationBindings = (
  endpoints: readonly EndpointPlan[],
  bindings: readonly ObservedPublication[],
): ReadonlyMap<string, readonly ObservedPublication[]> => {
  const publications = endpoints.filter((endpoint) => endpoint._tag === "published");
  const candidates = (endpoint: PublishedEndpoint) =>
    bindings.filter(
      (binding) =>
        binding.port === endpoint.port &&
        binding.transport === (endpoint.protocol === "udp" ? "udp" : "tcp") &&
        binding.bindAddress.replace(/^\[|\]$/gu, "") ===
          (endpoint.publication.bindAddress ?? "127.0.0.1").replace(/^\[|\]$/gu, "") &&
        (endpoint.publication.hostPort === undefined || endpoint.publication.hostPort === binding.hostPort),
    );
  const reserved = new Set(
    publications.filter((endpoint) => endpoint.publication.hostPort !== undefined).flatMap(candidates),
  );
  return new Map(
    publications.map((endpoint) => [
      physicalPublicationIdentity(endpoint),
      candidates(endpoint).filter(
        (binding) => endpoint.publication.hostPort !== undefined || !reserved.has(binding),
      ),
    ]),
  );
};

export const physicalPublications = (endpoints: readonly EndpointPlan[]) => {
  const publications = new Map<
    string,
    {
      readonly port: number;
      readonly transport: "tcp" | "udp";
      readonly bindAddress: string;
      readonly hostPort?: number;
    }
  >();
  for (const endpoint of endpoints) {
    if (endpoint._tag !== "published") continue;
    publications.set(physicalPublicationIdentity(endpoint), {
      port: endpoint.port,
      transport: endpoint.protocol === "udp" ? "udp" : "tcp",
      bindAddress: endpoint.publication.bindAddress ?? "127.0.0.1",
      ...(endpoint.publication.hostPort === undefined ? {} : { hostPort: endpoint.publication.hostPort }),
    });
  }
  return [...publications.values()];
};

export const physicalListenerPorts = (endpoints: readonly EndpointPlan[]): readonly string[] =>
  [
    ...new Set(
      endpoints.flatMap((endpoint) =>
        endpoint.protocol === "unix"
          ? []
          : [`${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`],
      ),
    ),
  ].sort();
