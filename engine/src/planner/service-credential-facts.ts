import type { DatabaseConnection, PortNumber, RouteText, ServiceCreds } from "@lando/sdk/schema";

export interface ServiceExpressionFacts {
  readonly creds?: ServiceCreds;
  readonly url: RouteText;
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
  const url: RouteText = { _tag: "RouteText", parts: [{ service: name, encoding: "raw" }] };
  if (service?.connection !== undefined)
    return { url, creds: service.connection.creds, port: service.connection.port };
  const port = plannedPort === undefined ? {} : { port: plannedPort };
  if (service?.nonSqlCreds !== undefined) return { url, creds: service.nonSqlCreds, ...port };
  return { url, ...port };
};
