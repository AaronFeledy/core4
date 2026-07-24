import { Schema } from "effect";

import { ProviderId } from "./primitives.ts";

// ============================================================================
// Provider setup planning — inspectable host changes authorized before apply.
// SPEC: §10.8 Setup and host integration.
// ============================================================================

export const InstallUidmapHostChange = Schema.TaggedStruct("install-uidmap", {
  platform: Schema.Literal("linux"),
  distribution: Schema.Literal("ubuntu"),
  version: Schema.Literal("26.04"),
  reason: Schema.String,
}).annotations({
  description:
    "Install Ubuntu's fixed uidmap package. This host change is valid only on Linux hosts identified as Ubuntu 26.04.",
});
export type InstallUidmapHostChange = typeof InstallUidmapHostChange.Type;

/** Closed provider-setup host-change union. Additions require a reviewed SDK contract change. */
export const ProviderSetupHostChange = Schema.Union(InstallUidmapHostChange);
export type ProviderSetupHostChange = typeof ProviderSetupHostChange.Type;

export const ProviderSetupPlan = Schema.Struct({
  providerId: ProviderId.annotations({ description: "Provider that inspected and will apply this plan." }),
  changes: Schema.Array(ProviderSetupHostChange).annotations({
    description: "Closed list of privileged host changes requiring core authorization.",
  }),
}).annotations({
  description: "Mutation-free provider setup plan inspected and authorized by core before provider apply.",
});
export type ProviderSetupPlan = typeof ProviderSetupPlan.Type;
