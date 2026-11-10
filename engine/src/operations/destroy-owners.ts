import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { matchesAppPlanIdentity } from "../providers/app-plan-identity.ts";
import { prepareTeardownOwners } from "../providers/runtime-observation.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";
import { PinnedAppRoot } from "./app-root-identity.ts";
import { ownedSnapshots } from "./destroy-snapshots.ts";

/** Gather durable ownership before evidence resolution can contact a runtime. */
export const prepareDestroyOwners = Effect.fn("AppOperation.prepareDestroyOwners")(function* (
  path: string,
  options: {
    readonly purgeSnapshots?: boolean;
    readonly target?: ResolvedAppTarget;
    readonly roots?: readonly AbsolutePath[];
  },
) {
  const root = AbsolutePath.make(yield* canonicalMissingAppRoot(path));
  const registry = yield* RuntimeProviderRegistry;
  const selected = yield* TeardownProvider;
  const roots = options.roots ?? [root];
  // An explicit provider reads only its own applied state; another provider's failure cannot block it.
  const plans = (yield* Effect.forEach(roots, (root) =>
    registry.appliedPlansFor(root, selected === undefined ? undefined : ProviderId.make(selected)),
  )).flat();
  const ownership =
    registry.resourceOwnership === undefined
      ? []
      : yield* Effect.forEach(selected === undefined ? yield* registry.list : [selected], (id) =>
          Effect.forEach(
            roots,
            (root) => registry.resourceOwnership?.(id, root) ?? Effect.succeed(undefined),
          ),
        );
  const journals = yield* Effect.forEach(roots, (root) =>
    readDiscardableStart({ kind: "user", id: AppId.make(root), root }).pipe(
      Effect.provideService(PinnedAppRoot, { requestedRoot: root, canonicalRoot: root }),
      Effect.map(({ pending }) => pending),
    ),
  );
  const snapshots = options.purgeSnapshots === true ? yield* ownedSnapshots(roots) : [];
  const owners = new Set([
    ...plans
      .filter((plan) => matchesAppPlanIdentity(plan, options.target?.app ?? { kind: "user", id: "" }))
      .map((plan) => plan.provider),
    // A target without a Landofile is the caller's applied evidence; a desired target proves nothing.
    ...(options.target === undefined || options.target.landofile !== undefined
      ? []
      : [options.target.plan.provider]),
    ...ownership.flat().flatMap((hint) => (hint === undefined ? [] : [hint.providerId])),
    ...journals.flatMap((pending) =>
      pending === null || pending.phase === "completed" || !roots.includes(AbsolutePath.make(pending.appRoot))
        ? []
        : [pending.providerId],
    ),
    ...snapshots.flatMap((snapshot) => (snapshot.native === undefined ? [] : [snapshot.native.provider])),
  ]);
  const providers = yield* Effect.forEach(
    [...owners].filter((id) => selected === undefined || id === selected),
    (id) => registry.select(ProviderId.make(id)),
  );
  yield* prepareTeardownOwners(providers);
});
