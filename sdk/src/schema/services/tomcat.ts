import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Tomcat catalog service authoring contract
// ============================================================================

export const TomcatServiceConfig = Schema.extend(
  ServiceConfig.pick(
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
  ),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("tomcat", "tomcat:9", "tomcat:10", "tomcat:11")).annotations({
      description: "Tomcat catalog service type and supported major-version aliases.",
    }),
  }),
).annotations({
  identifier: "TomcatServiceConfig",
  title: "Tomcat Service Config",
  description: "Landofile configuration accepted by the Tomcat catalog service.",
});
export type TomcatServiceConfig = typeof TomcatServiceConfig.Type;
