import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// phpMyAdmin catalog service authoring contract
// ============================================================================

export const PhpMyAdminServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
    "certs",
    "hosts",
    "creds",
    "environment",
    "routes",
    "ports",
    "command",
    "entrypoint",
    "workingDirectory",
    "appMount",
    "mounts",
    "storage",
    "endpoints",
    "healthcheck",
    "dependsOn",
    "labels",
    "envFile",
    "networks",
    "security",
    "providers",
  ),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("phpmyadmin", "phpmyadmin:5", "phpmyadmin:latest")).annotations({
      description: "phpMyAdmin catalog service type and supported version aliases.",
    }),
  }),
).annotations({
  identifier: "PhpMyAdminServiceConfig",
  title: "Php My Admin Service Config",
  description: "Landofile configuration accepted by the phpMyAdmin catalog service.",
});
export type PhpMyAdminServiceConfig = typeof PhpMyAdminServiceConfig.Type;
