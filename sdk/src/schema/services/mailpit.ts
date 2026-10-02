import { Struct } from "effect";
import { Schema } from "effect";

import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// Mailpit catalog service authoring contract
// ============================================================================

export const MailpitServiceConfig = Schema.Struct(
  Struct.pick(ServiceConfig.fields, [
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
  ]),
)
  .pipe(
    Schema.fieldsAssign({
      type: Schema.optionalKey(Schema.Literal("mailpit")).annotate({
        description: "Mailpit catalog service type.",
      }),
    }),
  )
  .annotate({
    identifier: "MailpitServiceConfig",
    title: "Mailpit Service Config",
    description: "Landofile configuration accepted by the Mailpit catalog service.",
  });
export type MailpitServiceConfig = typeof MailpitServiceConfig.Type;
