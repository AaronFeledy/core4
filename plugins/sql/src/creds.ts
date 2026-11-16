import { PlanReplanRequiredError } from "@lando/sdk/errors";
import type { DatabaseConnection, ServiceCreds } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { SqlPlanService } from "./views.ts";

export type SqlCreds = ServiceCreds & { readonly port: number };

export const currentAppliedDatabaseConnection = Effect.fn("Sql.currentAppliedDatabaseConnection")(function* (
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

export const resolveSqlCreds = (connection: DatabaseConnection): SqlCreds => ({
  ...connection.creds,
  port: connection.port,
});
