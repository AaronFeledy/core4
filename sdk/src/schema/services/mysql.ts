import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// MySQL catalog service authoring contract
// ============================================================================

export const MysqlServiceConfig = Schema.extend(
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
    type: Schema.optional(Schema.Literal("mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7")).annotations({
      description: "MySQL catalog service type and supported release-series aliases.",
    }),
  }),
).annotations({
  identifier: "MysqlServiceConfig",
  title: "MySQL Service Config",
  description: "Landofile configuration accepted by the MySQL catalog service.",
});
export type MysqlServiceConfig = typeof MysqlServiceConfig.Type;
