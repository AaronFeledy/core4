import { Schema } from "effect";

import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

// ============================================================================
// Mailpit catalog service authoring contract
// ============================================================================

export const MailpitServiceConfig = catalogServiceConfig({
  keys: [
    "image",
    "mailFrom",
    "port",
    "user",
    "database",
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
  ],
  type: catalogServiceType(Schema.Literal("mailpit"), "Mailpit catalog service type."),
  identifier: "MailpitServiceConfig",
  title: "Mailpit Service Config",
  description: "Landofile configuration accepted by the Mailpit catalog service.",
});
export type MailpitServiceConfig = typeof MailpitServiceConfig.Type;
