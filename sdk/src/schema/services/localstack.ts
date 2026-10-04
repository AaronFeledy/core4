import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// LocalStack catalog service authoring contract
// ============================================================================

export const LocalStackServiceConfig = catalogServiceConfig({
  extraKeys: ["database"],
  type: catalogServiceType(Schema.Literal("localstack"), "LocalStack catalog service type."),
  identifier: "LocalStackServiceConfig",
  title: "LocalStack Service Config",
  description: "Landofile configuration accepted by the LocalStack catalog service.",
});
export type LocalStackServiceConfig = typeof LocalStackServiceConfig.Type;
