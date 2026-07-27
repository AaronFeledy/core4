import { Schema } from "effect";

// =============================================================================
// Compose runtime knob capabilities — provider-declared preserved knob support.
// SPEC: §5.4, §5.5.1
// =============================================================================

export const ComposeServiceKnobKey = Schema.Literal(
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "tmpfs",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "init",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "pull_policy",
  "logging",
  "gpus",
  "deploy.resources",
).annotations({
  identifier: "ComposeServiceKnobKey",
  title: "Compose Service Knob Key",
  description: "Preserved Compose service runtime knob path eligible for provider capability declaration.",
});
export type ComposeServiceKnobKey = typeof ComposeServiceKnobKey.Type;

export const ComposeKnobCapabilities = Schema.Struct({
  supported: Schema.Array(ComposeServiceKnobKey).annotations({
    title: "Supported Compose Knobs",
    description: "Exact preserved Compose runtime knob paths supported by the provider.",
  }),
}).annotations({
  identifier: "ComposeKnobCapabilities",
  title: "Compose Knob Capabilities",
  description: "Fail-closed provider declaration of supported preserved Compose runtime knobs.",
});
export type ComposeKnobCapabilities = typeof ComposeKnobCapabilities.Type;
