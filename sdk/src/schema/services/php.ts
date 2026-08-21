import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// PHP catalog service authoring contract
// ============================================================================

export const PhpServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
    "webroot",
    "allowOverride",
    "composer",
    "via",
    "xdebug",
    "certs",
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
    type: Schema.optional(Schema.Literal("php:8.1", "php:8.2", "php:8.3", "php:8.4", "php:8.5")).annotations({
      description: "PHP catalog service type. PHP has no bare type: php alias; pin a supported minor.",
    }),
  }),
).annotations({
  identifier: "PhpServiceConfig",
  title: "Php Service Config",
  description: "Landofile configuration accepted by the PHP catalog service.",
});
export type PhpServiceConfig = typeof PhpServiceConfig.Type;
