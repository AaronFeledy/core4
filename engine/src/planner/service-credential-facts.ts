import type { DatabaseConnection, PortNumber, RouteText, ServiceCreds } from "@lando/sdk/schema";

export interface ServiceExpressionFacts {
  readonly creds?: ServiceCreds;
  readonly url: RouteText;
  readonly hostname: RouteText;
  readonly origin: RouteText;
  readonly port?: PortNumber;
}

export const serviceExpressionFacts = (
  name: string,
  service?: {
    readonly connection?: DatabaseConnection;
    readonly nonSqlCreds?: ServiceCreds;
  },
  /** The type's planned listen port, published when the service has no database connection. */
  plannedPort?: PortNumber,
): ServiceExpressionFacts => {
  const route = {
    url: { _tag: "RouteText", parts: [{ service: name, encoding: "raw" }] },
    hostname: { _tag: "RouteText", parts: [{ service: name, member: "hostname", encoding: "raw" }] },
    origin: { _tag: "RouteText", parts: [{ service: name, member: "origin", encoding: "raw" }] },
  } satisfies Pick<ServiceExpressionFacts, "url" | "hostname" | "origin">;
  if (service?.connection !== undefined)
    return { ...route, creds: service.connection.creds, port: service.connection.port };
  const port = plannedPort === undefined ? {} : { port: plannedPort };
  if (service?.nonSqlCreds !== undefined) return { ...route, creds: service.nonSqlCreds, ...port };
  return { ...route, ...port };
};
