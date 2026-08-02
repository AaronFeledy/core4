import { Schema } from "effect";

import { DeprecationNotice } from "./deprecation.ts";

export const CertificateAuthorityContribution = Schema.Struct({
  id: Schema.propertySignature(Schema.String).annotations({
    description: "Unique CertificateAuthority implementation id.",
  }),
  module: Schema.propertySignature(Schema.String).annotations({
    description: "Contained plugin module exporting the CertificateAuthority Layer.",
  }),
  defaultFor: Schema.optional(
    Schema.Struct({
      platform: Schema.optional(Schema.Array(Schema.String)),
    }),
  ).annotations({ description: "Host matchers that nominate this implementation as a default." }),
  enabledByDefault: Schema.optional(Schema.Boolean).annotations({
    description: "Whether this contribution starts enabled after installation.",
  }),
  summary: Schema.optional(Schema.String).annotations({
    description: "One-line implementation description for listings and diagnostics.",
  }),
  deprecated: Schema.optional(DeprecationNotice).annotations({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type CertificateAuthorityContribution = typeof CertificateAuthorityContribution.Type;
