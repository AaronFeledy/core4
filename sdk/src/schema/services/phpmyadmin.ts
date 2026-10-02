import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// phpMyAdmin Landofile service configuration
// ============================================================================

export const PhpMyAdminServiceConfig = Schema.Struct(Struct.pick(ServiceConfig.fields, ["image", "port", "user", "certs", "hosts", "creds", "environment", "routes", "ports", "command", "entrypoint", "workingDirectory", "appMount", "mounts", "storage", "endpoints", "healthcheck", "dependsOn", "labels", "envFile", "networks", "security", "providers"])).pipe(Schema.fieldsAssign({
    type: Schema.optionalKey(Schema.Literals(["phpmyadmin", "phpmyadmin:5", "phpmyadmin:latest"])).annotate({
      description: "phpMyAdmin catalog service type and supported version aliases.",
    }),
  })).annotate({
  identifier: "PhpMyAdminServiceConfig",
  title: "Php My Admin Service Config",
  description: "Landofile configuration accepted by the phpMyAdmin catalog service.",
});
export type PhpMyAdminServiceConfig = typeof PhpMyAdminServiceConfig.Type;
