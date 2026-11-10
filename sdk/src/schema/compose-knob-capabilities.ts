import { Schema } from "effect";

// =============================================================================
// Compose runtime knob capabilities — provider-declared preserved knob support.
// =============================================================================

export const ComposeServiceKnobKey = Schema.Literals([
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "logging",
  "gpus",
  "deploy.resources",
  "deploy.resources.reservations.devices",
]).annotate({
  identifier: "ComposeServiceKnobKey",
  title: "Compose Service Knob Key",
  description: "Preserved Compose service runtime knob path eligible for provider capability declaration.",
});
export type ComposeServiceKnobKey = typeof ComposeServiceKnobKey.Type;

export const WithheldComposeKnob = Schema.Struct({
  key: ComposeServiceKnobKey,
  remediation: Schema.String.annotate({
    description: "Host step that lets the provider declare the knob.",
  }),
}).annotate({
  identifier: "WithheldComposeKnob",
  title: "Withheld Compose Knob",
  description: "Knob the provider leaves undeclared on this host, with the step that would enable it.",
});
export type WithheldComposeKnob = typeof WithheldComposeKnob.Type;

export const ComposeKnobCapabilities = Schema.Struct({
  supported: Schema.Array(ComposeServiceKnobKey).annotate({
    title: "Supported Compose Knobs",
    description: "Exact preserved Compose runtime knob paths supported by the provider.",
  }),
  withheld: Schema.optionalKey(Schema.Array(WithheldComposeKnob)).annotate({
    title: "Withheld Compose Knobs",
    description:
      "Undeclared knobs the provider realizes only once a host condition is met; planning names the remediation.",
  }),
}).annotate({
  identifier: "ComposeKnobCapabilities",
  title: "Compose Knob Capabilities",
  description: "Fail-closed provider declaration of supported preserved Compose runtime knobs.",
});
export type ComposeKnobCapabilities = typeof ComposeKnobCapabilities.Type;
