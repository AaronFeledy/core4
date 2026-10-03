import { Effect } from "effect";

import { AppResolveError, type NoProviderInstalledError } from "@lando/sdk/errors";
import { type AbsolutePath, type AppPlan, type AppRef, appIdentityKey } from "@lando/sdk/schema";
import { type AppliedOrphanGroup, type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";

import { findAppRoot } from "@lando/landofile/discovery";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { resolveAppIdentity } from "../planner/app-identity.ts";

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

const mismatch = (detail: string): AppResolveError =>
  new AppResolveError({
    message: "The applied app state does not match the selected app ownership.",
    reason: "mismatch",
    detail,
    remediation: "Restore the matching app root or remove the conflicting provider state before retrying.",
  });

export const validateResolvedAppTarget = Effect.fnUntraced(function* (target: ResolvedAppTarget) {
  const registry = yield* RuntimeProviderRegistry;
  const plan = target.plan;
  const identity = plan.identity;
  if (target.root !== plan.root) {
    return yield* Effect.fail(mismatch("canonical-root"));
  }
  if (target.app.id !== plan.id || target.app.root !== plan.root) {
    return yield* Effect.fail(mismatch("app-ref"));
  }
  if (identity !== undefined) {
    if (plan.root !== identity.appRoot) {
      return yield* Effect.fail(mismatch("canonical-root"));
    }
    const canonicalIdentity = yield* resolveAppIdentity(target.root);
    if (canonicalIdentity.appRoot !== identity.appRoot) {
      return yield* Effect.fail(mismatch("canonical-root"));
    }
    if (canonicalIdentity.ownerKey !== identity.ownerKey) {
      return yield* Effect.fail(mismatch("owner-key"));
    }
  }
  const provider = yield* registry.select(plan);
  if (provider.id !== String(plan.provider)) {
    return yield* Effect.fail(mismatch("provider"));
  }
  return target;
});

const appliedStateTarget = (plan: AppPlan) =>
  plan.identity === undefined
    ? Effect.fail(mismatch("identity"))
    : validateResolvedAppTarget({
        plan,
        root: plan.root,
        app: appRef(plan),
      } satisfies ResolvedAppTarget);

export const missingRootAppliedTarget = Effect.fnUntraced(function* (plan: AppPlan, root: AbsolutePath) {
  if (plan.identity === undefined) return yield* Effect.fail(mismatch("identity"));
  if (plan.identity.appRoot !== root || plan.root !== root) {
    return yield* Effect.fail(mismatch("canonical-root"));
  }
  if (plan.identity.ownerKey !== appIdentityKey("owner", root)) {
    return yield* Effect.fail(mismatch("owner-key"));
  }
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(plan);
  if (provider.id !== String(plan.provider)) return yield* Effect.fail(mismatch("provider"));
  return { plan, root: plan.root, app: appRef(plan) } satisfies ResolvedAppTarget;
});

export const resolveAppliedStateTarget = Effect.gen(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const cwdIdentity = yield* resolveAppIdentity(process.cwd());
  const resolveAppliedPlan = registry.resolveAppliedPlan;
  if (resolveAppliedPlan === undefined) {
    return yield* Effect.fail(
      new AppResolveError({
        message: "The runtime provider registry cannot inspect applied app state.",
        reason: "not-found",
        detail: "applied-state-capability",
        remediation: "Use a runtime provider registry that supports applied-state recovery.",
      }),
    );
  }
  const plan = yield* resolveAppliedPlan(cwdIdentity.appRoot);
  if (plan === undefined) return undefined;
  return yield* appliedStateTarget(plan);
});

/** What teardown may act on for the discovered app root, decided before any desired config loads. */
export type TeardownResolution =
  | { readonly kind: "applied"; readonly target: ResolvedAppTarget }
  | {
      readonly kind: "orphans";
      readonly root: AbsolutePath;
      readonly groups: ReadonlyArray<AppliedOrphanGroup>;
    }
  | { readonly kind: "absent"; readonly root: AbsolutePath; readonly landofilePresent: boolean };

export const teardownResolutionAt = Effect.fnUntraced(function* <E, R>(
  root: AbsolutePath,
  landofilePresent: boolean,
  targetFor: (plan: AppPlan) => Effect.Effect<ResolvedAppTarget, E, R>,
): Effect.fn.Return<
  TeardownResolution,
  E | AppResolveError | ProviderError | NoProviderInstalledError,
  R | RuntimeProviderRegistry
> {
  const registry = yield* RuntimeProviderRegistry;
  const resolveEvidence = registry.resolveTeardownEvidence;
  const resolveAppliedPlan = registry.resolveAppliedPlan;
  const evidence =
    resolveEvidence !== undefined
      ? yield* resolveEvidence(root)
      : resolveAppliedPlan !== undefined
        ? yield* resolveAppliedPlan(root).pipe(
            Effect.map((plan) =>
              plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan },
            ),
          )
        : { kind: "absent" as const };
  switch (evidence.kind) {
    case "applied":
      return { kind: "applied", target: yield* targetFor(evidence.plan) };
    case "orphans":
      return { kind: "orphans", root, groups: evidence.groups };
    case "absent":
      return { kind: "absent", root, landofilePresent };
  }
});

/**
 * Resolves the app root by discovery, which succeeds while the Landofile is unreadable, then asks
 * the providers what they hold for that root. Callers load the desired config only afterwards, and
 * only when this reports nothing to remove.
 */
export const resolveTeardownResolution = Effect.gen(function* () {
  const discovered = yield* Effect.promise(() => findAppRoot(process.cwd()).catch(() => undefined));
  const identity = yield* resolveAppIdentity(discovered ?? process.cwd());
  const root = identity.appRoot;
  const landofilePresent = discovered !== undefined;
  return yield* teardownResolutionAt(root, landofilePresent, appliedStateTarget);
});
