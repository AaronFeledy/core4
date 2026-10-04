import { Schema } from "effect";

export const ComposeProjectFieldKey = Schema.Literals(["configs", "secrets"]).annotate({
  identifier: "ComposeProjectFieldKey",
  title: "Compose Project Field Key",
  description:
    "Preserved Compose project-level field requiring native composeSpec and an exact provider declaration.",
});
export type ComposeProjectFieldKey = typeof ComposeProjectFieldKey.Type;

export const ComposeProjectFieldCapabilities = Schema.Struct({
  supported: Schema.Array(ComposeProjectFieldKey).annotate({
    title: "Supported Compose Project Fields",
    description: "Exact preserved Compose project-level fields realized by a native-tier provider.",
  }),
}).annotate({
  identifier: "ComposeProjectFieldCapabilities",
  title: "Compose Project Field Capabilities",
  description:
    "Native-tier fail-closed provider declaration of realized Compose project-level fields; omitting it means no support.",
});
export type ComposeProjectFieldCapabilities = typeof ComposeProjectFieldCapabilities.Type;
