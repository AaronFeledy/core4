import { Schema } from "effect";

// =============================================================================
// Compose service field capabilities — provider-declared service field support.
// =============================================================================

export const ComposeServiceFieldKey = Schema.Literal(
  "networks",
  "configs",
  "secrets",
  "profiles",
  "x-*",
).annotations({
  identifier: "ComposeServiceFieldKey",
  title: "Compose Service Field Key",
  description: "Compose service-level field eligible for provider capability declaration.",
});
export type ComposeServiceFieldKey = typeof ComposeServiceFieldKey.Type;

export const ComposeServiceFieldCapabilities = Schema.Struct({
  supported: Schema.Array(ComposeServiceFieldKey).annotations({
    title: "Supported Compose Service Fields",
    description: "Exact Compose service-level fields supported by the provider.",
  }),
}).annotations({
  identifier: "ComposeServiceFieldCapabilities",
  title: "Compose Service Field Capabilities",
  description:
    "Fail-closed provider declaration of supported Compose service-level fields; omitting it means no support.",
});
export type ComposeServiceFieldCapabilities = typeof ComposeServiceFieldCapabilities.Type;
