import { Schema } from "effect";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "./primitives.ts";
import { VolumeRemovalCounts } from "./volume-removal.ts";

// ============================================================================
// Cleanup hints, never applied-state or readiness evidence
// ============================================================================
export const ResourceOwnership = Schema.Struct({
  appRoot: AbsolutePath.annotate({ description: "Canonical app root owning the cleanup hints." }),
  ownerKey: Schema.String.annotate({ description: "Canonical app ownership key." }),
  providerId: ProviderId.annotate({ description: "Provider holding the cleanup inventory." }),
  appIds: Schema.Array(AppId).annotate({ description: "App identities represented by the inventory." }),
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
