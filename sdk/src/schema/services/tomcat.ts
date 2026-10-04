import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Tomcat catalog service authoring contract
// ============================================================================

export const TomcatServiceConfig = Schema.Struct(
  Struct.pick(ServiceConfig.fields, [
    "image",
    "port",
    "user",
    "webroot",
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
      type: Schema.optionalKey(Schema.Literals(["tomcat", "tomcat:9", "tomcat:10", "tomcat:11"])).annotate({
        description: "Tomcat catalog service type and supported major-version aliases.",
      }),
    }),
  )
  .annotate({
    identifier: "TomcatServiceConfig",
    title: "Tomcat Service Config",
    description: "Landofile configuration accepted by the Tomcat catalog service.",
  });
export type TomcatServiceConfig = typeof TomcatServiceConfig.Type;
