import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// MinIO catalog service authoring contract
// ============================================================================

export const MinIOServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "database", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literal("minio")).annotate({
      description: "MinIO catalog service type.",
    }),
  })).annotate({
  identifier: "MinIOServiceConfig",
  title: "MinIO Service Config",
  description: "Landofile configuration accepted by the MinIO catalog service.",
});
export type MinIOServiceConfig = typeof MinIOServiceConfig.Type;
