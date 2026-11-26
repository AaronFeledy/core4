import { Schema } from "effect";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "./primitives.ts";
import { VolumeRemovalCounts } from "./volume-removal.ts";

// ============================================================================
// Cleanup hints, never applied-state or readiness evidence
// ============================================================================
export const ResourceOwnershipMember = Schema.Struct({
  kind: Schema.Literals(["container", "network", "volume"]).annotate({
    description: "Native resource kind recorded in the ownership inventory.",
  }),
  nativeName: Schema.String.annotate({ description: "Native resource name or container name." }),
  appId: AppId.annotate({ description: "App identity that owns this inventory member." }),
  service: Schema.optionalKey(
    ServiceName.annotate({ description: "Service name for container inventory members." }),
  ),
  dataRoot: Schema.optionalKey(
    AbsolutePath.annotate({
      description: "Data root that verified adoption of this native resource; absent on intent rows.",
    }),
  ),
  nativeId: Schema.optionalKey(
    Schema.String.annotate({ description: "Verified native ID of an adopted container or network." }),
  ),
  volumeInstance: Schema.optionalKey(
    Schema.String.annotate({ description: "Verified instance label of an adopted volume that carries one." }),
  ),
});
export type ResourceOwnershipMember = typeof ResourceOwnershipMember.Type;

export const ResourceOwnership = Schema.Struct({
  appRoot: AbsolutePath.annotate({ description: "Canonical app root owning the cleanup hints." }),
  ownerKey: Schema.String.annotate({ description: "Canonical app ownership key." }),
  providerId: ProviderId.annotate({ description: "Provider holding the cleanup inventory." }),
  appIds: Schema.Array(AppId).annotate({ description: "App identities represented by the inventory." }),
  members: Schema.optionalKey(
    Schema.Array(ResourceOwnershipMember).annotate({
      description:
        "Cleanup intent and verified adoption receipts. Only members with a data root are receipts.",
    }),
  ),
});
export type ResourceOwnership = typeof ResourceOwnership.Type;

export const OwnedResourcesCleanupResult = Schema.Struct({
  skipped: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        appId: AppId.annotate({ description: "App whose teardown considered this resource." }),
        resource: Schema.String.annotate({ description: "Native resource name retained without mutation." }),
        reason: Schema.String.annotate({
          description: "Why cleanup retained this resource, such as in use or unreadable applied state.",
        }),
        errorTag: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "Tag of the failure that protected this resource, such as AppliedStateVersionError for state a newer Lando wrote.",
          }),
        ),
        remediation: Schema.optionalKey(
          Schema.NonEmptyString.annotate({
            description: "How to resolve the failure that protected this resource.",
          }),
        ),
      }),
    ).annotate({ description: "Resources retained without failing teardown." }),
  ),
  servicesRemoved: Schema.Array(ServiceName).annotate({
    description: "Services whose observed containers were removed.",
  }),
  networksRemoved: Schema.Number.annotate({ description: "Number of observed private networks removed." }),
  volumesRemoved: VolumeRemovalCounts,
});
export type OwnedResourcesCleanupResult = typeof OwnedResourcesCleanupResult.Type;
