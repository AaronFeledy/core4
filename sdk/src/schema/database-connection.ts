import { Schema } from "effect";
import { Environment, EnvironmentValue } from "./environment-value.ts";
import { PortNumber } from "./primitives.ts";

// =============================================================================
// Connection facts resolved once by the database service type.
// =============================================================================
/** The four credential members shared by the connection fact and the local-client tuple. */
const serviceCredsMembers = {
  user: Schema.String.annotate({ description: "Literal database username." }),
  password: EnvironmentValue.annotate({
    description: "User password literal or deferred binding.",
  }),
  database: Schema.String.annotate({ description: "Literal database name." }),
  rootPassword: Schema.optionalKey(EnvironmentValue).annotate({
    description: "Optional administrative password literal or deferred binding.",
  }),
} as const;

export const ServiceCreds = Schema.Struct(serviceCredsMembers).annotate({
  identifier: "ServiceCreds",
  title: "Service Creds",
  description: "Database credentials with deferred password values.",
});
export type ServiceCreds = typeof ServiceCreds.Type;

export const DatabaseClientCreds = Schema.Struct({
  ...serviceCredsMembers,
  port: PortNumber.annotate({ description: "Planned database port the local client connects to." }),
}).annotate({
  identifier: "DatabaseClientCreds",
  title: "Database Client Creds",
  description:
    "Connection facts plus the planned port: the tuple every Lando-owned local database client consumes.",
});
export type DatabaseClientCreds = typeof DatabaseClientCreds.Type;

export const ServiceCredsConfig = Schema.Struct({
  user: Schema.optionalKey(Schema.String).annotate({ description: "Authored database username." }),
  password: Schema.optionalKey(EnvironmentValue).annotate({
    description: "Authored user password literal or deferred binding.",
  }),
  database: Schema.optionalKey(Schema.String).annotate({ description: "Authored database name." }),
  rootPassword: Schema.optionalKey(EnvironmentValue).annotate({
    description: "Authored administrative password literal or deferred binding.",
  }),
}).annotate({
  identifier: "ServiceCredsConfig",
  title: "Service Creds Config",
  description:
    "Authored credential members; every member is optional and omitted members take the service type's defaults.",
});
export type ServiceCredsConfig = typeof ServiceCredsConfig.Type;

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

export const ServiceCredsDisplay = Schema.Union([
  Schema.Struct({
    user: Schema.String.annotate({ description: "Displayed username." }),
    password: Schema.String.annotate({
      description:
        "Password display: a published development default literal, otherwise the redacted marker. A deferred reference is never resolved for info.",
    }),
    database: Schema.String.annotate({ description: "Displayed database name." }),
    rootPassword: Schema.optionalKey(Schema.String).annotate({
      description:
        "Optional administrative password display under the same published-default-literal-or-redacted rule.",
    }),
  }),
  Schema.Struct({
    engine: Schema.Literal("sqlite").annotate({ description: "File-backed database engine." }),
    path: Schema.String.annotate({
      description: "App-mount-relative path to the SQLite database file.",
    }),
  }),
]).annotate({
  identifier: "ServiceCredsDisplay",
  description:
    "String-only info view: server credentials, or a SQLite engine and path. Separate from deferred execution credentials.",
});
export type ServiceCredsDisplay = typeof ServiceCredsDisplay.Type;

// =============================================================================
// Post-readiness local credential check: one bounded authenticated query.
// =============================================================================
/** What one authenticated local query proved about the configured credentials. */
export const DatabaseClientCheckState = Schema.Literals([
  "accepted",
  "rejected",
  "database-missing",
  "unverified",
]).annotate({
  identifier: "DatabaseClientCheckState",
  description:
    "Local query verdict: accepted, rejected, database-missing, or unverified (absence of proof, never a rejection).",
});
export type DatabaseClientCheckState = typeof DatabaseClientCheckState.Type;

/**
 * The one thing classification consumes: the client's exit status and the stderr bytes it wrote.
 * Callers classify before redaction rewrites the text and never retain `stderr` afterwards.
 */
export const DatabaseClientCheckResult = Schema.Struct({
  exitCode: Schema.Int.annotate({ description: "Exit status the local client reported." }),
  stderr: Schema.String.annotate({
    description:
      "Client stderr as captured, before redaction. Classify it in place and discard it; never report or log it.",
  }),
}).annotate({
  identifier: "DatabaseClientCheckResult",
  title: "Database Client Check Result",
  description: "Unredacted client output a local credential check classifies.",
});
export type DatabaseClientCheckResult = typeof DatabaseClientCheckResult.Type;

export const DatabaseLocalCheck = Schema.Struct({
  argv: Schema.Array(Schema.String).annotate({
    description: "One authenticated, non-interactive query run inside the database's own container.",
  }),
  environment: Environment.annotate({
    description: "Unresolved environment values; resolve them through the shared environment session.",
  }),
  timeoutMs: Schema.Number.annotate({
    description: "Hard upper bound after which the result is unverified.",
  }),
}).annotate({
  identifier: "DatabaseLocalCheck",
  title: "Database Local Check",
  description: "The one local connection check a family and login run against their own service.",
});
export type DatabaseLocalCheck = typeof DatabaseLocalCheck.Type;
