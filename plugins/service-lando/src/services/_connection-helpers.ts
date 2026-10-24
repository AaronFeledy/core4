import type { DatabaseConnection, Environment } from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";
import { credentialValuesAgree, familyEnvFor, landoDbEnvFor } from "./_creds-helpers.ts";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

export const connectionFor = (ctx: ServiceFeatureContext): DatabaseConnection => {
  if (ctx.connection === undefined) {
    throw new ServiceConfigIssue(
      ["type"],
      "Database feature requires the service type's canonical connection fact.",
    );
  }
  return ctx.connection;
};

/** Call after all feature composition; overwrites must not silently diverge from connection facts. */
export const assertConnectionProjections = (
  connection: DatabaseConnection,
  environment: Environment,
): void => {
  const expected: Environment = {
    ...familyEnvFor(connection.family, connection.creds),
    ...landoDbEnvFor(connection.creds, connection.port),
    ...(connection.family === "mysql" || connection.family === "mariadb"
      ? { MYSQL_PWD: connection.creds.password, MYSQL_TCP_PORT: String(connection.port) }
      : connection.family === "postgres"
        ? { PGPORT: String(connection.port) }
        : connection.family === "mssql"
          ? { MSSQL_TCP_PORT: String(connection.port) }
          : {}),
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = environment[key];
    if (actual === undefined || !credentialValuesAgree(value, actual)) {
      throw new ServiceConfigIssue(
        ["environment", key],
        `connection conflicts with environment.${key}.`,
        "Remove the conflicting feature environment override.",
      );
    }
  }
};
