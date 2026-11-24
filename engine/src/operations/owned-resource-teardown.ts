import { basename } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AbsolutePath,
  type OwnedResourcesCleanupResult,
  type ResourceOwnership,
  type VolumeRemovalCounts,
  addVolumeRemovalCounts,
  noVolumesRemoved,
  volumesRemovedAny,
} from "@lando/sdk/schema";
import { type OwnedResourcesCleanupOptions, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";

export const prepareOwnedResourceCleanup = Effect.fnUntraced(function* (
  root: AbsolutePath,
  options: OwnedResourcesCleanupOptions,
  intent: "stop" | "destroy" = "destroy",
) {
  const registry = yield* RuntimeProviderRegistry;
  const evidence = yield* registry.resolveTeardownEvidence(root);
  const ownership = evidence.kind !== "absent" ? (evidence.ownership ?? []) : [];
  return yield* prepareOwnedResourceCleanupFrom(ownership, root, options, intent);
});

export const prepareOwnedResourceCleanupFrom = Effect.fnUntraced(function* (
  ownership: ReadonlyArray<ResourceOwnership>,
  root: AbsolutePath,
  options: OwnedResourcesCleanupOptions,
  intent: "stop" | "destroy" = "destroy",
) {
  const registry = yield* RuntimeProviderRegistry;
  const providers = yield* Effect.forEach(ownership, (hints) =>
    Effect.gen(function* () {
      const provider = yield* registry.select(hints.providerId);
      const cleanup = provider.cleanupOwnedResources;
      if (cleanup === undefined || !(yield* provider.isAvailable))
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: hints.providerId,
            operation: "cleanupOwnedResources",
            message: "The ownership inventory provider is unavailable or cannot clean up resources.",
            remediation: "Restore the owning provider before retrying teardown.",
          }),
        );
      if ((yield* provider.getStatus).state === "idle") {
        if (intent === "stop")
          return () =>
            Effect.succeed<OwnedResourcesCleanupResult>({
              servicesRemoved: [],
              networksRemoved: 0,
              volumesRemoved: { ...noVolumesRemoved },
            });
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: hints.providerId,
            operation: "cleanupOwnedResources",
            message: "The owning runtime is still idle; stored resources could not be inspected or removed.",
            remediation: "Inspect the runtime readiness failure with `lando doctor`, then retry destroy.",
          }),
        );
      }
      return (root: AbsolutePath, options: OwnedResourcesCleanupOptions) =>
        cleanup(root, { ...options, appIds: hints.appIds });
    }),
  );
  return Effect.gen(function* () {
    const result: {
      servicesRemoved: Array<OwnedResourcesCleanupResult["servicesRemoved"][number]>;
      networksRemoved: number;
      volumesRemoved: VolumeRemovalCounts;
      skipped: Array<NonNullable<OwnedResourcesCleanupResult["skipped"]>[number]>;
    } = {
      servicesRemoved: [],
      networksRemoved: 0,
      volumesRemoved: { ...noVolumesRemoved },
      skipped: [],
    };
    yield* runAllAndMergeFailures(
      providers.map((cleanup) =>
        cleanup(root, options).pipe(
          Effect.flatMap((removed) =>
            Effect.sync(() => {
              result.servicesRemoved.push(...removed.servicesRemoved);
              result.networksRemoved += removed.networksRemoved;
              result.volumesRemoved = addVolumeRemovalCounts(result.volumesRemoved, removed.volumesRemoved);
              result.skipped.push(...(removed.skipped ?? []));
            }),
          ),
        ),
      ),
    );
    const { skipped, ...removed } = result;
    return { ...removed, ...(skipped.length === 0 ? {} : { skipped }) };
  });
});

export const tearDownOwnedResources = Effect.fnUntraced(function* (
  root: AbsolutePath,
  options: OwnedResourcesCleanupOptions,
  intent: "stop" | "destroy" = "destroy",
) {
  const registry = yield* RuntimeProviderRegistry;
  const evidence = yield* registry.resolveTeardownEvidence(root);
  const ownership = evidence.kind !== "absent" ? (evidence.ownership ?? []) : [];
  return yield* withAppMutationLock(
    { id: ownership[0]?.appIds[0] ?? basename(root), root },
    Effect.gen(function* () {
      const cleanup = yield* prepareOwnedResourceCleanup(root, options, intent);
      return yield* cleanup;
    }),
  );
});

export const ownedCleanupChanged = (result: OwnedResourcesCleanupResult): boolean =>
  result.servicesRemoved.length > 0 || result.networksRemoved > 0 || volumesRemovedAny(result.volumesRemoved);
