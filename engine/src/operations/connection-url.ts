import type { EndpointRef, ServiceConnection, ServicePlan } from "@lando/sdk/schema";

export const connectionHost = (address: string): string => {
  const host = address.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host === "::" ? "::1" : host;
};

export const connectionUrl = (input: {
  readonly host: string;
  readonly port: number;
  readonly protocol: string;
  readonly pathPrefix?: string;
}): string => {
  const normalized = input.host.replace(/^\[|\]$/gu, "").toLowerCase();
  const host = normalized.includes(":") ? `[${normalized}]` : normalized;
  const standard =
    (input.protocol === "http" && input.port === 80) || (input.protocol === "https" && input.port === 443);
  return `${input.protocol}://${host}${standard ? "" : `:${input.port}`}${input.pathPrefix ?? ""}`;
};

export const clientConnectionUrls = (input: {
  readonly service: ServicePlan;
  readonly endpoint: EndpointRef;
  readonly protocol: ServiceConnection["protocol"];
  readonly host: string;
  readonly port: number;
}): { readonly url: string; readonly alternateUrls: readonly string[] } => {
  const uri = (protocol: string) => connectionUrl({ ...input, protocol });
  const tcpPorts = input.service.endpoints.flatMap((endpoint) =>
    endpoint.protocol === "tcp" ? [endpoint.port] : [],
  );
  const markedPrimary = input.service.endpoints.some(
    (endpoint) => endpoint.protocol !== "unix" && endpoint.primary,
  );
  const family =
    input.protocol === "tcp" &&
    tcpPorts.includes(input.endpoint.port) &&
    (input.endpoint.primary || (!markedPrimary && new Set(tcpPorts).size === 1));
  if (family) {
    switch (input.service.type.split(":")[0]) {
      case "postgres": {
        const user = encodeURIComponent(input.service.environment.POSTGRES_USER ?? "lando");
        const database = encodeURIComponent(input.service.environment.POSTGRES_DB ?? "postgres");
        return { url: `${uri("postgresql").replace("://", `://${user}@`)}/${database}`, alternateUrls: [] };
      }
      case "memcached":
        return { url: uri("memcached"), alternateUrls: [] };
      case "valkey":
        return { url: uri("valkey"), alternateUrls: [uri("redis")] };
    }
  }
  return { url: uri(input.protocol), alternateUrls: [] };
};
