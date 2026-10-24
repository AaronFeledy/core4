import type { ServiceConnection, ServiceCreds } from "@lando/sdk/schema";

export interface ServiceExpressionFacts {
  readonly creds: ServiceCreds;
  readonly port?: ServiceConnection["port"];
}

export const serviceExpressionFacts = (service: {
  readonly connection?: ServiceConnection;
  readonly nonSqlCreds?: ServiceCreds;
}): ServiceExpressionFacts | undefined => {
  if (service.connection !== undefined)
    return { creds: service.connection.creds, port: service.connection.port };
  if (service.nonSqlCreds !== undefined) return { creds: service.nonSqlCreds };
  return undefined;
};
