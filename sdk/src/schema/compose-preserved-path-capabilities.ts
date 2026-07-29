import { Schema } from "effect";

export const ComposePreservedPathKey = Schema.Literal(
  "depends_on.*.restart",
  "healthcheck.start_interval",
).annotations({
  identifier: "ComposePreservedPathKey",
  title: "Compose Preserved Path Key",
  description:
    "Matrix-preserved Compose service descendant requiring native composeSpec and an exact provider declaration.",
});
export type ComposePreservedPathKey = typeof ComposePreservedPathKey.Type;

export const ComposePreservedPathCapabilities = Schema.Struct({
  supported: Schema.Array(ComposePreservedPathKey).annotations({
    title: "Supported Compose Preserved Paths",
    description: "Exact matrix-preserved Compose descendant paths realized by a native-tier provider.",
  }),
}).annotations({
  identifier: "ComposePreservedPathCapabilities",
  title: "Compose Preserved Path Capabilities",
  description:
    "Native-tier fail-closed provider declaration of realized matrix-preserved Compose descendants; omitting it means no support.",
});
export type ComposePreservedPathCapabilities = typeof ComposePreservedPathCapabilities.Type;
