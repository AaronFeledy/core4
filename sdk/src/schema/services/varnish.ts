import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Varnish catalog service authoring contract
// ============================================================================

export const VarnishServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
    "port",
    "user",
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
    type: Schema.optional(Schema.Literal("varnish", "varnish:6", "varnish:7")).annotations({
      description: "Varnish catalog service type and supported major-version aliases.",
    }),
    backend: Schema.String.annotations({
      description: "Name of the app service this Varnish cache fronts.",
    }),
  }),
).annotations({
  identifier: "VarnishServiceConfig",
  title: "Varnish Service Config",
  description: "Landofile configuration accepted by the Varnish catalog service.",
});
export type VarnishServiceConfig = typeof VarnishServiceConfig.Type;
