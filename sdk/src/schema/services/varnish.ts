import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Varnish catalog service authoring contract
// ============================================================================

export const VarnishServiceConfig = Schema.Struct(
  Struct.pick(ServiceConfig.fields, [
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
  ]),
)
  .pipe(
    Schema.fieldsAssign({
      type: Schema.optionalKey(Schema.Literals(["varnish", "varnish:6", "varnish:7"])).annotate({
        description: "Varnish catalog service type and supported major-version aliases.",
      }),
      backend: Schema.String.annotate({
        description: "Name of the app service this Varnish cache fronts.",
      }),
    }),
  )
  .annotate({
    identifier: "VarnishServiceConfig",
    title: "Varnish Service Config",
    description: "Landofile configuration accepted by the Varnish catalog service.",
  });
export type VarnishServiceConfig = typeof VarnishServiceConfig.Type;
