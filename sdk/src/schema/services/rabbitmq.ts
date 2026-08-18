import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// RabbitMQ catalog service authoring contract
// ============================================================================

export const RabbitMQServiceConfig = Schema.extend(
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
    type: Schema.optional(Schema.Literal("rabbitmq", "rabbitmq:3", "rabbitmq:4")).annotations({
      description: "RabbitMQ catalog service type and supported major-version aliases.",
    }),
  }),
).annotations({
  identifier: "RabbitMQServiceConfig",
  title: "RabbitMQ Service Config",
  description: "Landofile configuration accepted by the RabbitMQ catalog service.",
});
export type RabbitMQServiceConfig = typeof RabbitMQServiceConfig.Type;
