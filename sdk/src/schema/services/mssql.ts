import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// SQL Server catalog service authoring contract
// ============================================================================

export const MssqlServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
    "database",
    "creds",
    "environment",
    "routes",
    "ports",
    "command",
    "entrypoint",
    "workingDirectory",
    "appMount",
    "mounts",
    "storage",
    "endpoints",
    "healthcheck",
    "dependsOn",
    "labels",
    "envFile",
    "networks",
    "security",
    "providers",
  ),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("mssql", "mssql:2019", "mssql:2022")).annotations({
      description: "SQL Server catalog service type and supported major-version aliases.",
    }),
  }),
).annotations({
  identifier: "MssqlServiceConfig",
  title: "Mssql Service Config",
  description: "Landofile configuration accepted by the SQL Server catalog service.",
});
export type MssqlServiceConfig = typeof MssqlServiceConfig.Type;
