import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// LocalStack catalog service authoring contract
// ============================================================================

export const LocalStackServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
    "database",
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
    type: Schema.optional(Schema.Literal("localstack")).annotations({
      description: "LocalStack catalog service type.",
    }),
  }),
).annotations({
  identifier: "LocalStackServiceConfig",
  title: "LocalStack Service Config",
  description: "Landofile configuration accepted by the LocalStack catalog service.",
});
export type LocalStackServiceConfig = typeof LocalStackServiceConfig.Type;
