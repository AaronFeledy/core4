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
    "db_client",
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
    type: Schema.optional(
      Schema.String.pipe(
        Schema.pattern(/^php:[^:\s]+$/u, {
          message: () => "PHP service types use php:<version> syntax.",
        }),
      ).annotations({
        description:
          "PHP catalog service type. PHP has no bare type: php alias; the planner validates the requested version against shipped ServiceType metadata.",
      }),
    ),
  }),
).annotations({
  identifier: "PhpServiceConfig",
  title: "Php Service Config",
  description: "Landofile configuration accepted by the PHP catalog service.",
});
export type PhpServiceConfig = typeof PhpServiceConfig.Type;
