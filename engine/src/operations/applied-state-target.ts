import { basename } from "node:path";

import { Effect } from "effect";

import { AppResolveError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

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

export const currentDirectoryAppName = (): string => basename(process.cwd()) || process.cwd();

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
  const identity = plan.identity;
  if (identity === undefined) return yield* Effect.fail(mismatch("identity"));
  if (plan.root !== identity.appRoot) return yield* Effect.fail(mismatch("canonical-root"));
  const canonicalIdentity = yield* resolveAppIdentity(plan.root);
  if (canonicalIdentity.appRoot !== identity.appRoot) {
    return yield* Effect.fail(mismatch("canonical-root"));
  }
  if (canonicalIdentity.ownerKey !== identity.ownerKey) {
    return yield* Effect.fail(mismatch("owner-key"));
  }
  const provider = yield* registry.select(plan);
  if (provider.id !== String(plan.provider)) {
    return yield* Effect.fail(mismatch("provider"));
  }
  return {
    plan,
    root: plan.root,
    app: appRef(plan),
  } satisfies ResolvedAppTarget;
});
