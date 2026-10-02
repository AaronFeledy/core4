import { Schema } from "effect";

export const ComposeServiceFieldKey = Schema.Literals(["networks", "configs", "secrets", "profiles", "labels"]).annotate({
  identifier: "ComposeServiceFieldKey",
  title: "Compose Service Field Key",
  description:
    "Preserved Compose service-level field requiring native composeSpec and an exact provider declaration.",
});
export type ComposeServiceFieldKey = typeof ComposeServiceFieldKey.Type;

export const ComposeServiceFieldCapabilities = Schema.Struct({
  supported: Schema.Array(ComposeServiceFieldKey).annotate({
    title: "Supported Compose Service Fields",
    description: "Exact preserved Compose service-level fields realized by a native-tier provider.",
  }),
}).annotate({
  identifier: "ComposeServiceFieldCapabilities",
  title: "Compose Service Field Capabilities",
  description:
    "Native-tier fail-closed provider declaration of realized Compose service-level fields; omitting it means no support.",
});
export type ComposeServiceFieldCapabilities = typeof ComposeServiceFieldCapabilities.Type;
