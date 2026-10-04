import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// RabbitMQ catalog service authoring contract
// ============================================================================

export const RabbitMQServiceConfig = catalogServiceConfig({
  extraKeys: ["database"],
  type: catalogServiceType(
    Schema.Literals(["rabbitmq", "rabbitmq:3", "rabbitmq:4"]),
    "RabbitMQ catalog service type and supported major-version aliases.",
  ),
  identifier: "RabbitMQServiceConfig",
  title: "RabbitMQ Service Config",
  description: "Landofile configuration accepted by the RabbitMQ catalog service.",
});
export type RabbitMQServiceConfig = typeof RabbitMQServiceConfig.Type;
