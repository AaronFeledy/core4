import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// MinIO catalog service authoring contract
// ============================================================================

export const MinIOServiceConfig = Schema.extend(
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
    type: Schema.optional(Schema.Literal("minio")).annotations({
      description: "MinIO catalog service type.",
    }),
  }),
).annotations({
  identifier: "MinIOServiceConfig",
  title: "MinIO Service Config",
  description: "Landofile configuration accepted by the MinIO catalog service.",
});
export type MinIOServiceConfig = typeof MinIOServiceConfig.Type;
