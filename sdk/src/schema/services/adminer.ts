import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// Adminer Landofile service configuration
// ============================================================================

export const AdminerServiceConfig = catalogServiceConfig({
  type: catalogServiceType(
    Schema.Literals(["adminer", "adminer:6"]),
    "Adminer catalog service type and version.",
  ),
  identifier: "AdminerServiceConfig",
  title: "Adminer Service Config",
  description: "Landofile configuration accepted by the Adminer catalog service.",
});
export type AdminerServiceConfig = typeof AdminerServiceConfig.Type;
