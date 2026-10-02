import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// MySQL catalog service authoring contract
// ============================================================================

export const MysqlServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "database", "creds", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literals(["mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7"])).annotate({
      description: "MySQL catalog service type and supported release-series aliases.",
    }),
  })).annotate({
  identifier: "MysqlServiceConfig",
  title: "MySQL Service Config",
  description: "Landofile configuration accepted by the MySQL catalog service.",
});
export type MysqlServiceConfig = typeof MysqlServiceConfig.Type;
