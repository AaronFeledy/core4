import { Struct } from "effect";
import { Schema } from "effect";

import { DeprecationNotice, deprecateSchema } from "../deprecation.ts";
import { ServiceConfig } from "../landofile.ts";

// ============================================================================
// MailHog catalog service authoring contract (deprecated compatibility type)
// ============================================================================

export const MAILHOG_DEPRECATION_NOTICE = Schema.decodeUnknownSync(DeprecationNotice)({
  since: "4.2.0",
  removeIn: "5.0.0",
  severity: "warn",
  replacement: "mailpit",
  note: "MailHog is deprecated. Use type: mailpit.",
});

export const MailhogServiceConfig = deprecateSchema(
  Schema.Struct(
    Struct.pick(ServiceConfig.fields, [
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
    ]),
  )
    .pipe(
      Schema.fieldsAssign({
        type: Schema.optionalKey(Schema.Literal("mailhog")).annotate({
          description: "Deprecated MailHog catalog service type. Use mailpit.",
        }),
      }),
    )
    .annotate({
      identifier: "MailhogServiceConfig",
      title: "MailHog Service Config",
      description: "Landofile configuration accepted by the deprecated MailHog catalog service.",
    }),
  MAILHOG_DEPRECATION_NOTICE,
);
export type MailhogServiceConfig = typeof MailhogServiceConfig.Type;
