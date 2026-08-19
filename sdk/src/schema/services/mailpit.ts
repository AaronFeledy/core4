import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Mailpit catalog service authoring contract
// ============================================================================

export const MailpitServiceConfig = Schema.extend(
  ServiceConfig.pick(
    "image",
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
  ),
  Schema.Struct({
    type: Schema.optional(Schema.Literal("mailpit")).annotations({
      description: "Mailpit catalog service type.",
    }),
  }),
).annotations({
  identifier: "MailpitServiceConfig",
  title: "Mailpit Service Config",
  description: "Landofile configuration accepted by the Mailpit catalog service.",
});
export type MailpitServiceConfig = typeof MailpitServiceConfig.Type;
