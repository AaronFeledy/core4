import { Schema } from "effect";

export const ComposePreservedPathKey = Schema.Literals([
  "depends_on.*.restart",
  "healthcheck.start_interval",
  "networks.*.ipv4_address",
  "networks.*.ipv6_address",
  "networks.*.link_local_ips",
  "networks.*.mac_address",
  "networks.*.driver_opts",
  "networks.*.priority",
  "networks.*.gw_priority",
  "networks.*.interface_name",
]).annotate({
  identifier: "ComposePreservedPathKey",
  title: "Compose Preserved Path Key",
  description:
    "Matrix-preserved Compose service descendant requiring native composeSpec and an exact provider declaration.",
});
export type ComposePreservedPathKey = typeof ComposePreservedPathKey.Type;

export const ComposePreservedPathCapabilities = Schema.Struct({
  supported: Schema.Array(ComposePreservedPathKey).annotate({
    title: "Supported Compose Preserved Paths",
    description: "Exact matrix-preserved Compose descendant paths realized by a native-tier provider.",
  }),
}).annotate({
  identifier: "ComposePreservedPathCapabilities",
  title: "Compose Preserved Path Capabilities",
  description:
    "Native-tier fail-closed provider declaration of realized matrix-preserved Compose descendants; omitting it means no support.",
});
export type ComposePreservedPathCapabilities = typeof ComposePreservedPathCapabilities.Type;
