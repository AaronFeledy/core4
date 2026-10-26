import type { DatabaseConnection, ServiceCreds } from "@lando/sdk/schema";

export interface ServiceExpressionFacts {
  readonly creds: ServiceCreds;
  readonly port?: DatabaseConnection["port"];
}

export const serviceExpressionFacts = (service: {
  readonly connection?: DatabaseConnection;
  readonly nonSqlCreds?: ServiceCreds;
}): ServiceExpressionFacts | undefined => {
  if (service.connection !== undefined)
    return { creds: service.connection.creds, port: service.connection.port };
  if (service.nonSqlCreds !== undefined) return { creds: service.nonSqlCreds };
  return undefined;
};
