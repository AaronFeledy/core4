import { Schema } from "effect";
import { CertificateSpec } from "../schema/networking.ts";

// ============================================================================
// Complete leaf material and apply-time preparation data
// ============================================================================

export const CertificateMaterial = Schema.Struct({
  certificate: Schema.String.annotateKey({ description: "Public PEM leaf certificate." }),
  privateKey: Schema.Redacted(Schema.String, { disallowJsonEncode: true }).annotateKey({
    description: "Redacted PEM private key matching the leaf.",
  }),
}).annotate({
  identifier: "CertificateMaterial",
  title: "Certificate Material",
  description: "Complete leaf material with a private key protected from inspection and JSON encoding.",
});
export type CertificateMaterial = typeof CertificateMaterial.Type;

export const CertificatePairPreparation = Schema.Struct({
  spec: CertificateSpec.annotateKey({ description: "Names the prepared leaf must cover." }),
  root: Schema.String.annotateKey({
    description: "Current signing root PEM snapshot used to judge stored material.",
  }),
  existing: Schema.optionalKey(CertificateMaterial).annotateKey({
    description: "Complete stored pair, when both files are available.",
  }),
  subject: Schema.String.annotateKey({
    description: "Human subject used in an unusable-issuance failure, for example service web.",
  }),
}).annotate({
  identifier: "CertificatePairPreparation",
  title: "Certificate Pair Preparation",
  description: "Apply-time request to reuse or issue a current leaf pair.",
});
export type CertificatePairPreparation = typeof CertificatePairPreparation.Type;

export const PreparedCertificatePair = Schema.Struct({
  source: Schema.Literals(["reused", "issued"]).annotateKey({
    description: "Whether the material was reused or freshly issued.",
  }),
  ...CertificateMaterial.fields,
  root: Schema.String.annotateKey({ description: "Signing root PEM for the effective pair." }),
}).annotate({
  identifier: "PreparedCertificatePair",
  title: "Prepared Certificate Pair",
  description: "Validated effective leaf material and signing root, ready for caller-owned publication.",
});
export type PreparedCertificatePair = typeof PreparedCertificatePair.Type;
