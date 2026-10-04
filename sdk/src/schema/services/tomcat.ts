import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// Tomcat catalog service authoring contract
// ============================================================================

export const TomcatServiceConfig = catalogServiceConfig({
  extraKeys: ["webroot", "certs"],
  type: catalogServiceType(
    Schema.Literals(["tomcat", "tomcat:9", "tomcat:10", "tomcat:11"]),
    "Tomcat catalog service type and supported major-version aliases.",
  ),
  identifier: "TomcatServiceConfig",
  title: "Tomcat Service Config",
  description: "Landofile configuration accepted by the Tomcat catalog service.",
});
export type TomcatServiceConfig = typeof TomcatServiceConfig.Type;
