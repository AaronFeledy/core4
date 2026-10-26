import { DATABASE_FAMILY_ENV_KEYS, DATABASE_PORT_ENV_KEY } from "@lando/sdk/database-creds";
import { canonicalJson } from "@lando/sdk/digest";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type EnvironmentValue,
  type ServicePlan,
  normalizeEnvironmentValue,
  validationIssue,
} from "@lando/sdk/schema";
import { Effect } from "effect";

export const validateConnectionValues = Effect.fn("Planner.validateConnectionValues")(function* (
  appRoot: string,
  services: Readonly<Record<string, ServicePlan>>,
) {
  for (const [name, service] of Object.entries(services)) {
    const connection = service.connection;
    if (connection === undefined) continue;
    const expected: Record<string, EnvironmentValue> = {
      LANDO_DB_USER: connection.creds.user,
      LANDO_DB_PASSWORD: connection.creds.password,
      LANDO_DB_NAME: connection.creds.database,
      [DATABASE_PORT_ENV_KEY]: String(connection.port),
    };
    if (connection.creds.rootPassword !== undefined)
      expected.LANDO_DB_ROOT_PASSWORD = connection.creds.rootPassword;
    for (const field of ["user", "password", "database", "rootPassword"] as const) {
      const value = connection.creds[field];
      if (value === undefined) continue;
      for (const key of DATABASE_FAMILY_ENV_KEYS[connection.family][field]) expected[key] = value;
    }
    if (connection.family === "mssql") expected.SQLCMDPASSWORD = connection.creds.password;
    switch (connection.family) {
      case "mysql":
      case "mariadb":
        expected.MYSQL_PWD = connection.creds.password;
        expected.MYSQL_TCP_PORT = String(connection.port);
        break;
      case "postgres":
        expected.PGPORT = String(connection.port);
        break;
      case "mssql":
        expected.MSSQL_TCP_PORT = String(connection.port);
        break;
      case "mongodb":
        break;
      default:
        connection.family satisfies never;
    }
    for (const [key, value] of Object.entries(expected)) {
      const actual = service.environment[key];
      if (
        actual === undefined ||
        canonicalJson(normalizeEnvironmentValue(actual)) === canonicalJson(normalizeEnvironmentValue(value))
      )
        continue;
      const path = ["services", name, "environment", key];
      return yield* Effect.fail(
        new LandofileValidationError({
          message: `Service ${name} environment.${key} conflicts with its resolved connection after feature composition.`,
          file: `${appRoot}/.lando.yml`,
          remediation:
            "Keep database environment projections consistent with the resolved connection; change the connection inputs instead.",
          issues: [
            validationIssue(path, `environment.${key} conflicts with connection.creds / connection.port.`),
          ],
        }),
      );
    }
  }
});
