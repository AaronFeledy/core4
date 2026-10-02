import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// PHP catalog service authoring contract
// ============================================================================

export const PhpServiceConfig = Schema.Struct(
  Struct.pick(ServiceConfig.fields, [
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
  ]),
)
  .pipe(
    Schema.fieldsAssign({
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
    }),
  )
  .annotate({
    identifier: "PhpServiceConfig",
    title: "Php Service Config",
    description: "Landofile configuration accepted by the PHP catalog service.",
  });
export type PhpServiceConfig = typeof PhpServiceConfig.Type;
