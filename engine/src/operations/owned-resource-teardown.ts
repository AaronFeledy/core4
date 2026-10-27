import { basename } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AbsolutePath, OwnedResourcesCleanupResult, ResourceOwnership } from "@lando/sdk/schema";
import { type DestroyOptions, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";

export const prepareOwnedResourceCleanup = Effect.fnUntraced(function* (
  root: AbsolutePath,
  options: DestroyOptions,
) {
  const registry = yield* RuntimeProviderRegistry;
  const evidence = yield* registry.resolveTeardownEvidence(root);
  const ownership = evidence.kind !== "absent" ? (evidence.ownership ?? []) : [];
  return yield* prepareOwnedResourceCleanupFrom(ownership, root, options);
});

export const prepareOwnedResourceCleanupFrom = Effect.fnUntraced(function* (
  ownership: ReadonlyArray<ResourceOwnership>,
  root: AbsolutePath,
  options: DestroyOptions,
) {
  const registry = yield* RuntimeProviderRegistry;
  const providers = yield* Effect.forEach(ownership, (hints) =>
    Effect.gen(function* () {
      const provider = yield* registry.select(hints.providerId);
      const cleanup = provider.cleanupOwnedResources;
      if (cleanup === undefined || !(yield* provider.isAvailable) || !(yield* provider.getStatus).running)
        return yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: hints.providerId,
            operation: "cleanupOwnedResources",
            message: "The ownership inventory provider is unavailable or cannot clean up resources.",
            remediation: "Restore the owning provider before retrying teardown.",
          }),
        );
      return (root: AbsolutePath, options: DestroyOptions) =>
        cleanup(root, { ...options, appIds: hints.appIds });
    }),
  );
  return Effect.gen(function* () {
    const result: {
      servicesRemoved: Array<OwnedResourcesCleanupResult["servicesRemoved"][number]>;
      networksRemoved: number;
      volumesRemoved: number;
      skipped: Array<NonNullable<OwnedResourcesCleanupResult["skipped"]>[number]>;
    } = {
      servicesRemoved: [],
      networksRemoved: 0,
      volumesRemoved: 0,
      skipped: [],
    };
    yield* runAllAndMergeFailures(
      providers.map((cleanup) =>
        cleanup(root, options).pipe(
          Effect.map((removed) => {
            result.servicesRemoved.push(...removed.servicesRemoved);
            result.networksRemoved += removed.networksRemoved;
            result.volumesRemoved += removed.volumesRemoved;
            result.skipped.push(...(removed.skipped ?? []));
          }),
        ),
      ),
    );
    const { skipped, ...removed } = result;
    return { ...removed, ...(skipped.length === 0 ? {} : { skipped }) };
  });
});

export const tearDownOwnedResources = Effect.fnUntraced(function* (
  root: AbsolutePath,
  options: DestroyOptions,
) {
  const registry = yield* RuntimeProviderRegistry;
  const evidence = yield* registry.resolveTeardownEvidence(root);
  const ownership = evidence.kind !== "absent" ? (evidence.ownership ?? []) : [];
  return yield* withAppMutationLock(
    { id: ownership[0]?.appIds[0] ?? basename(root), root },
    Effect.gen(function* () {
      const cleanup = yield* prepareOwnedResourceCleanup(root, options);
      return yield* cleanup;
    }),
  );
});

export const ownedCleanupChanged = (result: OwnedResourcesCleanupResult): boolean =>
  result.servicesRemoved.length > 0 || result.networksRemoved > 0 || result.volumesRemoved > 0;
