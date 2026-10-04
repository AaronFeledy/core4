import { Schema } from "effect";

import { DeprecationNotice, deprecateSchema } from "../deprecation.ts";
import { catalogServiceConfig, catalogServiceType } from "./_catalog.ts";

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
  catalogServiceConfig({
    extraKeys: ["database"],
    type: catalogServiceType(
      Schema.Literal("mailhog"),
      "Deprecated MailHog catalog service type. Use mailpit.",
    ),
    identifier: "MailhogServiceConfig",
    title: "MailHog Service Config",
    description: "Landofile configuration accepted by the deprecated MailHog catalog service.",
  }),
  MAILHOG_DEPRECATION_NOTICE,
);
export type MailhogServiceConfig = typeof MailhogServiceConfig.Type;
