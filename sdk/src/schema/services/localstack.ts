import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// LocalStack catalog service authoring contract
// ============================================================================

export const LocalStackServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "database", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literal("localstack")).annotate({
      description: "LocalStack catalog service type.",
    }),
  })).annotate({
  identifier: "LocalStackServiceConfig",
  title: "LocalStack Service Config",
  description: "Landofile configuration accepted by the LocalStack catalog service.",
});
export type LocalStackServiceConfig = typeof LocalStackServiceConfig.Type;
