import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// Varnish catalog service authoring contract
// ============================================================================

export const VarnishServiceConfig = catalogServiceConfig({
  extraKeys: ["certs"],
  type: catalogServiceType(
    Schema.Literals(["varnish", "varnish:6", "varnish:7"]),
    "Varnish catalog service type and supported major-version aliases.",
  ),
  fields: {
    backend: Schema.String.annotate({
      description: "Name of the app service this Varnish cache fronts.",
    }),
  },
  identifier: "VarnishServiceConfig",
  title: "Varnish Service Config",
  description: "Landofile configuration accepted by the Varnish catalog service.",
});
export type VarnishServiceConfig = typeof VarnishServiceConfig.Type;
