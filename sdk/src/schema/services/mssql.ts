import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// SQL Server catalog service authoring contract
// ============================================================================

export const MssqlServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "database", "creds", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literals(["mssql", "mssql:2019", "mssql:2022"])).annotate({
      description: "SQL Server catalog service type and supported major-version aliases.",
    }),
  })).annotate({
  identifier: "MssqlServiceConfig",
  title: "Mssql Service Config",
  description: "Landofile configuration accepted by the SQL Server catalog service.",
});
export type MssqlServiceConfig = typeof MssqlServiceConfig.Type;
