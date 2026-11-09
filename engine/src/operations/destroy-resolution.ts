import { resolve as resolvePath } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { AppResolveError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { matchesAppPlanIdentity } from "../providers/app-plan-identity.ts";
import { shellArg } from "../services/shell-quote.ts";
import { canonicalMissingAppRoot, withAppMutationLock } from "./app-mutation-lock.ts";
import {
  type TeardownResolution,
  missingRootAppliedTarget,
  teardownResolutionAt,
} from "./applied-state-target.ts";
import { prepareDestroyOwners } from "./destroy-owners.ts";

export const withMissingDestroyRoot = Effect.fn("AppOperation.withMissingDestroyRoot")(function* <A, E, R>(
  root: string,
  options: { readonly purgeSnapshots?: boolean },
  body: (resolved: {
    readonly resolution: TeardownResolution;
    readonly candidates: readonly AbsolutePath[];
  }) => Effect.Effect<A, E, R>,
) {
  const requested = AbsolutePath.make(resolvePath(root));
  const canonical = AbsolutePath.make(
    yield* canonicalMissingAppRoot(root).pipe(
      mapFailures(
        (error) =>
          new AppResolveError({
            reason: "missing-root",
            detail: "unresolvable-root",
            message: `The app folder path ${requested} cannot be resolved.`,
            remediation:
              typeof error.cause === "object" &&
              error.cause !== null &&
              "code" in error.cause &&
              error.cause.code === "ENOENT"
                ? `Part of ${requested} is a symlink whose target no longer exists. Remove or fix that symlink, then rerun lando destroy --root ${shellArg(requested)}.`
                : `Check that you can read every folder in ${requested}, then rerun.`,
            cause: error,
          }),
      ),
    ),
  );
  const candidates = requested === canonical ? [requested] : [requested, canonical];
  const fs = yield* FileSystem;
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate))
      return yield* Effect.fail(
        new AppResolveError({
          reason: "mismatch",
          detail: "root-exists",
          message: `The app folder ${candidate} still exists.`,
          remediation: `Run lando destroy from inside ${candidate}. --root is only for app folders that no longer exist.`,
        }),
      );
  }
  return yield* withAppMutationLock(
    { kind: "user", id: canonical, root: canonical },
    Effect.gen(function* () {
      yield* prepareDestroyOwners(root, { ...options, roots: candidates });
      const registry = yield* RuntimeProviderRegistry;
      const providerId = yield* TeardownProvider;
      const resolveAt = Effect.fnUntraced(function* (recorded: AbsolutePath) {
        const plans = (yield* registry.appliedPlansFor(recorded)).filter(
          (plan) =>
            (providerId === undefined || plan.provider === providerId) &&
            matchesAppPlanIdentity(plan, { kind: "user", id: "" }),
        );
        return yield* teardownResolutionAt(
          recorded,
          false,
          (plan) => missingRootAppliedTarget(plan, recorded),
          plans[0] === undefined ? undefined : { kind: "user", id: plans[0].id },
        );
      });
      const requestedResolution = yield* resolveAt(requested);
      const resolution =
        requestedResolution.kind === "absent" && canonical !== requested
          ? yield* resolveAt(canonical)
          : requestedResolution;
      return yield* body({ resolution, candidates });
    }),
  );
});
