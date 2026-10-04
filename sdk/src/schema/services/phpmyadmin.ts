import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// phpMyAdmin Landofile service configuration
// ============================================================================

export const PhpMyAdminServiceConfig = catalogServiceConfig({
  extraKeys: ["certs", "hosts", "creds"],
  type: catalogServiceType(
    Schema.Literals(["phpmyadmin", "phpmyadmin:5", "phpmyadmin:latest"]),
    "phpMyAdmin catalog service type and supported version aliases.",
  ),
  identifier: "PhpMyAdminServiceConfig",
  title: "Php My Admin Service Config",
  description: "Landofile configuration accepted by the phpMyAdmin catalog service.",
});
export type PhpMyAdminServiceConfig = typeof PhpMyAdminServiceConfig.Type;
