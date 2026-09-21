import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan, AppRef } from "@lando/sdk/schema";
import { type AppliedOrphanGroup, RuntimeProviderRegistry } from "@lando/sdk/services";

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

export const validateResolvedAppTarget = (target: ResolvedAppTarget) =>
  Effect.gen(function* () {
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
  const registry = yield* RuntimeProviderRegistry;
  const resolveEvidence = registry.resolveTeardownEvidence;
  if (resolveEvidence === undefined) {
    const resolveAppliedPlan = registry.resolveAppliedPlan;
    if (resolveAppliedPlan === undefined) {
      return { kind: "absent" as const, root, landofilePresent };
    }
    const plan = yield* resolveAppliedPlan(root);
    return plan === undefined
      ? { kind: "absent" as const, root, landofilePresent }
      : { kind: "applied" as const, target: yield* appliedStateTarget(plan) };
  }
  const evidence = yield* resolveEvidence(root);
  switch (evidence.kind) {
    case "applied":
      return { kind: "applied" as const, target: yield* appliedStateTarget(evidence.plan) };
    case "orphans":
      return { kind: "orphans" as const, root, groups: evidence.groups };
    case "absent":
      return { kind: "absent" as const, root, landofilePresent };
  }
});
