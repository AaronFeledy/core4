import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// SQL Server catalog service authoring contract
// ============================================================================

export const MssqlServiceConfig = catalogServiceConfig({
  extraKeys: ["database", "creds"],
  type: catalogServiceType(
    Schema.Literals(["mssql", "mssql:2019", "mssql:2022"]),
    "SQL Server catalog service type and supported major-version aliases.",
  ),
  identifier: "MssqlServiceConfig",
  title: "Mssql Service Config",
  description: "Landofile configuration accepted by the SQL Server catalog service.",
});
export type MssqlServiceConfig = typeof MssqlServiceConfig.Type;
