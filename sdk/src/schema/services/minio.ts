import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// MinIO catalog service authoring contract
// ============================================================================

export const MinIOServiceConfig = catalogServiceConfig({
  extraKeys: ["database"],
  type: catalogServiceType(Schema.Literal("minio"), "MinIO catalog service type."),
  identifier: "MinIOServiceConfig",
  title: "MinIO Service Config",
  description: "Landofile configuration accepted by the MinIO catalog service.",
});
export type MinIOServiceConfig = typeof MinIOServiceConfig.Type;
