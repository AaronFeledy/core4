import { Schema } from "effect";

import { DeprecationNotice } from "./deprecation.ts";

export const CertificateAuthorityContribution = Schema.Struct({
  id: Schema.String.annotateKey({
    description: "Unique CertificateAuthority implementation id.",
  }),
  module: Schema.String.annotateKey({
    description: "Contained plugin module exporting the CertificateAuthority Layer.",
  }),
  defaultFor: Schema.optionalKey(Schema.Struct({
      platform: Schema.optionalKey(Schema.Array(Schema.String)),
    })).annotate({ description: "Host matchers that nominate this implementation as a default." }),
  enabledByDefault: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether this contribution starts enabled after installation.",
  }),
  summary: Schema.optionalKey(Schema.String).annotate({
    description: "One-line implementation description for listings and diagnostics.",
  }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({
    description: "Optional lifecycle notice for this contribution.",
  }),
});
export type CertificateAuthorityContribution = typeof CertificateAuthorityContribution.Type;
