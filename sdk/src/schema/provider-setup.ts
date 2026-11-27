import { Schema } from "effect";

import { ProviderId } from "./primitives.ts";

// ============================================================================
// Provider setup planning — inspectable host changes authorized before apply.
// Setup and host integration schemas.
// ============================================================================

export const InstallUidmapHostChange = Schema.TaggedStruct("install-uidmap", {
  platform: Schema.Literal("linux"),
  distribution: Schema.String,
  version: Schema.String,
  reason: Schema.String,
}).annotate({
  description:
    "Install uidmap package on supported Linux distributions. Supported on Ubuntu and Debian via apt-get.",
});
export type InstallUidmapHostChange = typeof InstallUidmapHostChange.Type;

export const ProvisionSubuidHostChange = Schema.TaggedStruct("provision-subuid", {
  user: Schema.String,
  start: Schema.Number,
  count: Schema.Number,
  reason: Schema.String,
}).annotate({
  description: "Add subordinate UID range to /etc/subuid when missing. Does not modify existing ranges.",
});
export type ProvisionSubuidHostChange = typeof ProvisionSubuidHostChange.Type;

export const ProvisionSubgidHostChange = Schema.TaggedStruct("provision-subgid", {
  user: Schema.String,
  start: Schema.Number,
  count: Schema.Number,
  reason: Schema.String,
}).annotate({
  description: "Add subordinate GID range to /etc/subgid when missing. Does not modify existing ranges.",
});
export type ProvisionSubgidHostChange = typeof ProvisionSubgidHostChange.Type;

export const ProvisionCgroupsDelegationHostChange = Schema.TaggedStruct("provision-cgroups-delegation", {
  path: Schema.String,
  reason: Schema.String,
}).annotate({
  description:
    "Create systemd cgroups v2 delegation drop-in when missing. Does not overwrite existing drop-ins.",
});
export type ProvisionCgroupsDelegationHostChange = typeof ProvisionCgroupsDelegationHostChange.Type;

export const EnableUserLingerHostChange = Schema.TaggedStruct("enable-user-linger", {
  user: Schema.String,
  uid: Schema.Number,
  optedIn: Schema.Boolean.annotate({
    description:
      "Whether the user already opted in through the provider's setup flag. Lingering persists across logout and reboot, so `--yes` alone never approves it.",
  }),
  reason: Schema.String,
}).annotate({
  description:
    "Enable systemd lingering for the user so a systemd user manager runs without a login session. Needs its own consent.",
});
export type EnableUserLingerHostChange = typeof EnableUserLingerHostChange.Type;

/** Closed provider-setup host-change union. Additions require a reviewed SDK contract change. */
export const ProviderSetupHostChange = Schema.Union([
  InstallUidmapHostChange,
  ProvisionSubuidHostChange,
  ProvisionSubgidHostChange,
  ProvisionCgroupsDelegationHostChange,
  EnableUserLingerHostChange,
]);
export type ProviderSetupHostChange = typeof ProviderSetupHostChange.Type;

/** The `_tag` of every provider-setup host change, for errors that name the change they concern. */
export const ProviderSetupHostChangeTag = Schema.Literals([
  "install-uidmap",
  "provision-subuid",
  "provision-subgid",
  "provision-cgroups-delegation",
  "enable-user-linger",
]);
export type ProviderSetupHostChangeTag = typeof ProviderSetupHostChangeTag.Type;

export const ProviderSetupPlan = Schema.Struct({
  providerId: ProviderId.annotate({ description: "Provider that inspected and will apply this plan." }),
  changes: Schema.Array(ProviderSetupHostChange).annotate({
    description: "Closed list of privileged host changes requiring core authorization.",
  }),
}).annotate({
  description: "Mutation-free provider setup plan inspected and authorized by core before provider apply.",
});
export type ProviderSetupPlan = typeof ProviderSetupPlan.Type;
