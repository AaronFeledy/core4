import { Schema } from "effect";

import { catalogServiceConfig } from "./_catalog.ts";

// ============================================================================
// PHP catalog service authoring contract
// ============================================================================

export const PhpServiceConfig = catalogServiceConfig({
  extraKeys: ["webroot", "allowOverride", "composer", "via", "xdebug", "db_client", "certs"],
  type: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^php:[^:\s]+$/u, {
          message: "PHP service types use php:<version> syntax.",
        }),
      ),
    ).annotate({
      description:
        "PHP catalog service type. PHP has no bare type: php alias; the planner validates the requested version against shipped ServiceType metadata.",
    }),
  ),
  identifier: "PhpServiceConfig",
  title: "Php Service Config",
  description: "Landofile configuration accepted by the PHP catalog service.",
});
export type PhpServiceConfig = typeof PhpServiceConfig.Type;
