import { Schema } from "effect";

export const ComposePreservedPathKey = Schema.Literals([
  "depends_on.*.restart",
  "healthcheck.start_interval",
]).annotate({
  identifier: "ComposePreservedPathKey",
  title: "Compose Preserved Path Key",
  description:
    "Matrix-preserved Compose service descendant requiring native composeSpec and an exact provider declaration.",
});
export type ComposePreservedPathKey = typeof ComposePreservedPathKey.Type;

export const WithheldComposePreservedPath = Schema.Struct({
  key: ComposePreservedPathKey,
  remediation: Schema.String.annotate({
    description: "Step that lets the provider declare the path, or why this host cannot yet.",
  }),
}).annotate({
  identifier: "WithheldComposePreservedPath",
  title: "Withheld Compose Preserved Path",
  description:
    "Preserved path the provider leaves undeclared on this host, with the step that would enable it.",
});
export type WithheldComposePreservedPath = typeof WithheldComposePreservedPath.Type;

export const ComposePreservedPathCapabilities = Schema.Struct({
  supported: Schema.Array(ComposePreservedPathKey).annotate({
    title: "Supported Compose Preserved Paths",
    description: "Exact matrix-preserved Compose descendant paths realized by a native-tier provider.",
  }),
  withheld: Schema.optionalKey(Schema.Array(WithheldComposePreservedPath)).annotate({
    title: "Withheld Compose Preserved Paths",
    description:
      "Undeclared paths the provider realizes only once a host condition is met; planning names the remediation.",
  }),
}).annotate({
  identifier: "ComposePreservedPathCapabilities",
  title: "Compose Preserved Path Capabilities",
  description:
    "Native-tier fail-closed provider declaration of realized matrix-preserved Compose descendants; omitting it means no support.",
});
export type ComposePreservedPathCapabilities = typeof ComposePreservedPathCapabilities.Type;
