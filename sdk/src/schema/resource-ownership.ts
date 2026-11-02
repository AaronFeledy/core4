import { Schema } from "effect";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "./primitives.ts";

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
        appId: AppId.annotate({ description: "App whose unreadable state protects this resource." }),
        resource: Schema.String.annotate({ description: "Native resource name retained without mutation." }),
        reason: Schema.String.annotate({
          description: "Unreadable-state refusal explaining why cleanup skipped this resource.",
        }),
      }),
    ).annotate({ description: "Protected resources skipped because their applied state is unreadable." }),
  ),
  servicesRemoved: Schema.Array(ServiceName).annotate({
    description: "Services whose observed containers were removed.",
  }),
  networksRemoved: Schema.Number.annotate({ description: "Number of observed private networks removed." }),
  volumesRemoved: Schema.Number.annotate({
    description: "Number of policy-selected observed volumes removed.",
  }),
});
export type OwnedResourcesCleanupResult = typeof OwnedResourcesCleanupResult.Type;
