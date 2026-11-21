import type { DatabaseConnection, RouteText, ServiceCreds } from "@lando/sdk/schema";

export interface ServiceExpressionFacts {
  readonly creds?: ServiceCreds;
  readonly url: RouteText;
  readonly port?: DatabaseConnection["port"];
}

export const serviceExpressionFacts = (
  name: string,
  service?: {
    readonly connection?: DatabaseConnection;
    readonly nonSqlCreds?: ServiceCreds;
  },
): ServiceExpressionFacts => {
  const url: RouteText = { _tag: "RouteText", parts: [{ service: name, encoding: "raw" }] };
  if (service?.connection !== undefined)
    return { url, creds: service.connection.creds, port: service.connection.port };
  if (service?.nonSqlCreds !== undefined) return { url, creds: service.nonSqlCreds };
  return { url };
};
