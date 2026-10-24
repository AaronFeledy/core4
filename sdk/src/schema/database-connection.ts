import { Schema } from "effect";
import { EnvironmentValue } from "./environment-value.ts";
import { PortNumber } from "./primitives.ts";

// =============================================================================
// Connection facts resolved once by the database service type.
// =============================================================================
export const ServiceCreds = Schema.Struct({
  user: Schema.String.annotate({ description: "Literal database username." }),
  password: EnvironmentValue.annotate({ description: "User password literal or deferred binding." }),
  database: Schema.String.annotate({ description: "Literal database name." }),
  rootPassword: Schema.optionalKey(EnvironmentValue).annotate({
    description: "Optional administrative password literal or deferred binding.",
  }),
}).annotate({
  identifier: "ServiceCreds",
  title: "Service Creds",
  description: "Database credentials with deferred password values.",
});
export type ServiceCreds = typeof ServiceCreds.Type;

export const DatabaseConnection = Schema.Struct({
  family: Schema.Literals(["mysql", "mariadb", "postgres", "mongodb", "mssql"]).annotate({
    description: "Database protocol family.",
  }),
  creds: ServiceCreds.annotate({
    description: "Effective credentials, shared by initialization and all clients.",
  }),
  port: PortNumber.annotate({ description: "Planned database TCP port." }),
}).annotate({
  identifier: "DatabaseConnection",
  description: "Canonical database connection facts owned by service-type resolution.",
});
export type DatabaseConnection = typeof DatabaseConnection.Type;

export const ServiceCredsDisplay = Schema.Struct({
  user: Schema.String.annotate({ description: "Displayed username." }),
  password: Schema.String.annotate({ description: "Redacted password display, never resolved for info." }),
  database: Schema.String.annotate({ description: "Displayed database name." }),
  rootPassword: Schema.optionalKey(Schema.String).annotate({
    description: "Optional redacted administrative password display.",
  }),
}).annotate({
  identifier: "ServiceCredsDisplay",
  description: "String-only info view, separate from deferred execution credentials.",
});
export type ServiceCredsDisplay = typeof ServiceCredsDisplay.Type;
