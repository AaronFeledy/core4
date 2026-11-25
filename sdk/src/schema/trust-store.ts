import { Schema } from "effect";

// ====
// Host trust stores a CertificateAuthority manages, as inspected and as changed by setup.

/**
 * `trusted`: the store contains the root. `untrusted`: Lando verified the root is absent, or a
 * repair failed. `unknown`: Lando could not inspect the store.
 */
export const TrustStoreState = Schema.Literals(["trusted", "untrusted", "unknown"]).annotate({
  description:
    "Whether the store contains the local CA root: trusted (it does), untrusted (verified absent, or a repair failed), or unknown (Lando could not inspect it).",
});
export type TrustStoreState = typeof TrustStoreState.Type;

/** One host trust store and whether it contains the authority's root. Reading it never installs trust. */
export const TrustStoreStatus = Schema.Struct({
  id: Schema.String.annotate({
    description:
      'Store kind, e.g. "system" or "homebrew". Several stores may share a kind; location tells them apart.',
  }),
  name: Schema.String.annotate({ description: "Human name of the store, e.g. Homebrew CA bundle." }),
  location: Schema.optionalKey(Schema.String).annotate({
    description: "Where the store lives, such as a bundle file or database directory.",
  }),
  state: TrustStoreState,
  reason: Schema.optionalKey(Schema.String).annotate({
    description:
      'Machine cause of a state other than trusted, e.g. "missing", "refresh-failed", or "inspection-failed".',
  }),
  detail: Schema.optionalKey(Schema.String).annotate({
    description: "Human explanation of the state, such as the error a repair tool printed.",
  }),
  remediation: Schema.optionalKey(Schema.String).annotate({
    description: "What to do so the store trusts the local CA.",
  }),
}).annotate({ description: "One host trust store and whether it contains the local CA root." });
export type TrustStoreStatus = typeof TrustStoreStatus.Type;

/** A trust store as `setup` left it. */
export const TrustStoreChange = Schema.Struct({
  ...TrustStoreStatus.fields,
  changed: Schema.Boolean.annotate({
    description: "True when setup verified the store untrusted before it ran and trusted afterwards.",
  }),
}).annotate({
  description: "A host trust store as setup left it, and whether setup made it trust the local CA.",
});
export type TrustStoreChange = typeof TrustStoreChange.Type;
