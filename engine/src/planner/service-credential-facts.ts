import type {
  DatabaseConnection,
  PortNumber,
  PublicRouteFact,
  RouteText,
  ServiceCreds,
} from "@lando/sdk/schema";

export interface ServiceExpressionFacts extends Readonly<Record<PublicRouteFact, RouteText>> {
  readonly creds?: ServiceCreds;
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
  const binding = (fact: PublicRouteFact): RouteText => ({
    _tag: "RouteText",
    parts: [{ service: name, ...(fact === "url" ? {} : { member: fact }), encoding: "raw" }],
  });
  const route = {
    url: binding("url"),
    hostname: binding("hostname"),
    origin: binding("origin"),
    publicPort: binding("publicPort"),
    scheme: binding("scheme"),
  } satisfies Readonly<Record<PublicRouteFact, RouteText>>;
  if (service?.connection !== undefined)
    return { ...route, creds: service.connection.creds, port: service.connection.port };
  const port = plannedPort === undefined ? {} : { port: plannedPort };
  if (service?.nonSqlCreds !== undefined) return { ...route, creds: service.nonSqlCreds, ...port };
  return { ...route, ...port };
};
