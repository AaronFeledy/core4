import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// RabbitMQ catalog service authoring contract
// ============================================================================

export const RabbitMQServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "database", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literals(["rabbitmq", "rabbitmq:3", "rabbitmq:4"])).annotate({
      description: "RabbitMQ catalog service type and supported major-version aliases.",
    }),
  })).annotate({
  identifier: "RabbitMQServiceConfig",
  title: "RabbitMQ Service Config",
  description: "Landofile configuration accepted by the RabbitMQ catalog service.",
});
export type RabbitMQServiceConfig = typeof RabbitMQServiceConfig.Type;
