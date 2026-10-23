import { PlanReplanRequiredError } from "@lando/sdk/errors";
import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "@lando/sdk/expressions";
import type { Environment, ServiceConnection, ServiceCreds } from "@lando/sdk/schema";
import { Effect, absurd } from "effect";
import type { SqlFamily } from "./families.ts";
import type { SqlPlanService } from "./views.ts";

export type SqlCreds = ServiceCreds & { readonly port: number };

export const currentAppliedServiceConnection = Effect.fn("Sql.currentAppliedServiceConnection")(function* (
  service: SqlPlanService,
  context: { readonly app: string; readonly providerId: string },
) {
  if (service.connection === undefined) {
    return yield* Effect.fail(
      new PlanReplanRequiredError({
        app: context.app,
        providerId: context.providerId,
        operation: "database connection",
        message: `Applied service ${service.name} has no database connection facts.`,
        remediation: "Run `lando rebuild` to apply a current database plan, then retry the database command.",
      }),
    );
  }
  return service.connection;
});

export const resolveSqlCreds = (connection: ServiceConnection): SqlCreds => ({
  ...connection.creds,
  port: connection.port,
});

export const credsEnv = (family: SqlFamily, creds: SqlCreds): Environment => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return { MYSQL_PWD: creds.password };
    case "postgres":
      return { PGPASSWORD: creds.password };
    case "mongodb":
      return {
        MONGO_URI: concatenateEnvironmentValues([
          "mongodb://",
          encodeEnvironmentComponent(creds.user),
          ":",
          encodeEnvironmentComponent(creds.password),
          `@127.0.0.1:${creds.port}/`,
          encodeEnvironmentComponent(creds.database),
          "?authSource=admin",
        ]),
      };
    case "mssql": {
      const password = creds.rootPassword ?? creds.password;
      return { SQLCMDPASSWORD: password, SA_PASSWORD: password, MSSQL_SA_PASSWORD: password };
    }
    default:
      return absurd(family);
  }
};
