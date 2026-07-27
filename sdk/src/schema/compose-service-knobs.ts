import { Schema } from "effect";

import { ComposeDevicesField, ComposeUlimitsField } from "./compose-knob-devices.ts";
import { ComposeExtraHostsField, ComposeSysctlsField } from "./compose-knob-maps.ts";
import { ComposeDeployField, ComposeGpusField, ComposeLogging } from "./compose-knob-resources.ts";
import {
  ComposeBooleanOrStringField,
  ComposeCapAddField,
  ComposeCapDropField,
  ComposeDnsField,
  ComposeDnsOptField,
  ComposeDnsSearchField,
  ComposeGroupAddField,
  ComposePullPolicyField,
  ComposeRestartField,
  ComposeSecurityOptField,
  ComposeShmSizeField,
  ComposeStopGracePeriodField,
  ComposeTmpfsField,
} from "./compose-knob-scalars.ts";

export * from "./compose-knob-devices.ts";
export * from "./compose-knob-maps.ts";
export * from "./compose-knob-resources.ts";
export * from "./compose-knob-scalars.ts";

const describeEncodedField = <A, I>(schema: Schema.Schema<A, I, never>, description: string) =>
  Schema.compose(Schema.encodedBoundSchema(schema).annotations({ description }), schema).annotations({
    description,
  });

export const ComposeServiceKnobFields = {
  restart: Schema.optional(ComposeRestartField).annotations({
    description: "Container restart policy: no, always, on-failure, or unless-stopped.",
  }),
  cap_add: Schema.optionalWith(
    describeEncodedField(
      ComposeCapAddField,
      "Linux capabilities to add as a single Compose capability or capability list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Linux capabilities added to the container; a scalar canonicalizes to a list.",
  }),
  cap_drop: Schema.optionalWith(
    describeEncodedField(
      ComposeCapDropField,
      "Linux capabilities to drop as a single Compose capability or capability list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Linux capabilities removed from the container; a scalar canonicalizes to a list.",
  }),
  privileged: Schema.optional(ComposeBooleanOrStringField).annotations({
    description: "Whether the container runs with extended host privileges.",
  }),
  devices: Schema.optionalWith(
    describeEncodedField(
      ComposeDevicesField,
      "Device mappings as source:target[:permissions] strings or long source, target, and permissions objects; canonicalized to a list of long objects.",
    ),
    { exact: true },
  ).annotations({
    description: "Host device mappings; short source:target[:permissions] entries canonicalize to objects.",
  }),
  ulimits: Schema.optionalWith(
    describeEncodedField(
      ComposeUlimitsField,
      "Process limits as integer or string scalars, or explicit soft and hard objects; canonicalized to a map of soft and hard limit objects.",
    ),
    { exact: true },
  ).annotations({
    description: "Process resource limits; scalar limits canonicalize to explicit soft and hard values.",
  }),
  sysctls: Schema.optionalWith(
    describeEncodedField(
      ComposeSysctlsField,
      "Kernel parameters as a Compose scalar map or KEY=value list; canonicalized to a scalar map.",
    ),
    { exact: true },
  ).annotations({
    description: "Container kernel parameters as a map or KEY=value list, canonicalized to a map.",
  }),
  tmpfs: Schema.optionalWith(
    describeEncodedField(
      ComposeTmpfsField,
      "Temporary filesystem mounts as a single Compose mount string or string list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Temporary filesystem mounts; a scalar mount specification canonicalizes to a list.",
  }),
  shm_size: Schema.optionalWith(
    describeEncodedField(
      ComposeShmSizeField,
      "Shared-memory size as integer bytes or a Compose byte-size string; canonicalized to integer bytes.",
    ),
    { exact: true },
  ).annotations({
    description:
      "Shared-memory allocation in bytes or as a Compose byte-size literal, canonicalized to bytes.",
  }),
  dns: Schema.optionalWith(
    describeEncodedField(
      ComposeDnsField,
      "Custom DNS servers as a single address or address list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Custom DNS servers; a scalar address canonicalizes to a list.",
  }),
  dns_search: Schema.optionalWith(
    describeEncodedField(
      ComposeDnsSearchField,
      "DNS search domains as a single domain or domain list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Custom DNS search domains; a scalar domain canonicalizes to a list.",
  }),
  dns_opt: Schema.optionalWith(
    describeEncodedField(
      ComposeDnsOptField,
      "Resolver options as a single Compose option or option list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Resolver options; a scalar option canonicalizes to a list.",
  }),
  extra_hosts: Schema.optionalWith(
    describeEncodedField(
      ComposeExtraHostsField,
      "Additional host mappings as a hostname-to-address map or HOST=IP and HOST:IP list; canonicalized to a hostname map.",
    ),
    { exact: true },
  ).annotations({
    description: "Additional hostname mappings as a map or HOST:IP list, canonicalized to a map.",
  }),
  init: Schema.optional(ComposeBooleanOrStringField).annotations({
    description: "Whether an init process forwards signals and reaps child processes in the container.",
  }),
  stop_signal: Schema.optional(Schema.String).annotations({
    description: "Signal used to request graceful container shutdown, such as SIGTERM.",
  }),
  stop_grace_period: Schema.optionalWith(
    describeEncodedField(
      ComposeStopGracePeriodField,
      "Graceful-stop period as a Compose duration string or canonical numeric seconds; canonicalized to seconds.",
    ),
    { exact: true },
  ).annotations({
    description: "Graceful shutdown duration as Compose syntax, canonicalized to seconds.",
  }),
  security_opt: Schema.optionalWith(
    describeEncodedField(
      ComposeSecurityOptField,
      "Container security options as a single Compose option or option list; canonicalized to a string list.",
    ),
    { exact: true },
  ).annotations({
    description: "Container security labeling options; a scalar option canonicalizes to a list.",
  }),
  group_add: Schema.optionalWith(
    describeEncodedField(
      ComposeGroupAddField,
      "Supplementary groups as one string or number, or as a list of either; canonicalized to a group list while preserving each value.",
    ),
    { exact: true },
  ).annotations({
    description: "Supplementary container groups; a scalar group canonicalizes to a list.",
  }),
  read_only: Schema.optional(ComposeBooleanOrStringField).annotations({
    description: "Whether the container root filesystem is mounted read-only.",
  }),
  platform: Schema.optional(Schema.String).annotations({
    description: "Target runtime platform in operating-system and architecture form.",
  }),
  pull_policy: Schema.optional(ComposePullPolicyField).annotations({
    description: "Upstream Compose policy controlling when the service image is pulled.",
  }),
  logging: Schema.optional(ComposeLogging).annotations({
    description: "Container logging driver and driver-specific scalar options.",
  }),
  gpus: Schema.optionalWith(
    describeEncodedField(
      ComposeGpusField,
      'GPU access as the Compose literal "all" or a device-request list; canonical output preserves "all" or uses device objects with options canonicalized to maps.',
    ),
    { exact: true },
  ).annotations({
    description: "GPU allocation as all devices or a list of driver-specific device requests.",
  }),
  deploy: Schema.optionalWith(
    describeEncodedField(
      ComposeDeployField,
      "Deployment resources as null or a limits and reservations object; canonicalized to resources-only data with memory in bytes and device options as maps, while Swarm orchestration keys are rejected.",
    ),
    { exact: true },
  ).annotations({
    description: "Container resource limits and reservations; Swarm orchestration fields are rejected.",
  }),
} as const;

export const ComposeServiceKnobs = Schema.Struct(ComposeServiceKnobFields);
export type ComposeServiceKnobs = typeof ComposeServiceKnobs.Type;
