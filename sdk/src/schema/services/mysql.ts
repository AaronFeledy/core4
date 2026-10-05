import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// MySQL catalog service authoring contract
// ============================================================================

export const MysqlServiceConfig = catalogServiceConfig({
  extraKeys: ["database", "creds"],
  type: catalogServiceType(
    Schema.Literals(["mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7"]),
    "MySQL catalog service type and supported release-series aliases.",
  ),
  identifier: "MysqlServiceConfig",
  title: "MySQL Service Config",
  description: "Landofile configuration accepted by the MySQL catalog service.",
});
export type MysqlServiceConfig = typeof MysqlServiceConfig.Type;
