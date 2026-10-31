import { dirname } from "node:path";
import { Context, Effect } from "effect";

import { AppLockTimeoutError, GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { GlobalAppService, type PathsService, type StateStore } from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import {
  canonicalMissingAppRoot,
  heldGlobalAppMutationRoot,
  withAppMutationLock,
} from "../operations/app-mutation-lock.ts";

import { withGlobalActivationScope } from "./activation-scope.ts";
import { globalPolicyBucket } from "./enablement.ts";

export type GlobalMutationServices = GlobalAppService | PathsService | StateStore | PrivateFileAccessService;

const HeldGlobalPolicy = Context.Reference<{ readonly policy: string; readonly root: string } | undefined>(
  "@lando/engine/HeldGlobalPolicy",
  {
    defaultValue: () => undefined,
  },
);

/** Policy identity is shared even when embedded hosts use different runtime and data roots. */
export const globalPolicyIdentity = Effect.gen(function* () {
  const bucket = yield* globalPolicyBucket();
  return yield* canonicalMissingAppRoot(bucket.path);
});

/** Acquire shared policy before the actual global app, preserving its pinned runtime root. */
export const withGlobalMutation = Effect.fnUntraced(function* <A, E, R>(
  body: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E | GlobalAppError, R | GlobalMutationServices> {
  const globalApp = yield* GlobalAppService;
  const paths = yield* globalApp.paths;
  const coordinate = Effect.gen(function* () {
    const policy = yield* globalPolicyIdentity;
    const root = yield* canonicalMissingAppRoot(paths.root);
    const held = yield* HeldGlobalPolicy;
    const actualRootHeld = yield* heldGlobalAppMutationRoot;
    if (held === undefined && actualRootHeld !== undefined)
      return yield* Effect.fail(
        new StateStoreError({
          reason: "lock",
          operation: "globalPolicyLockUpgrade",
          path: policy,
          remediation:
            "Acquire the global policy coordinator before the global app mutation lock. Run this operation after the current global mutation finishes.",
        }),
      );
    if (held !== undefined && (held.policy !== policy || held.root !== root))
      return yield* Effect.fail(
        new StateStoreError({
          reason: "lock",
          operation: "nestedGlobalPolicyMutation",
          path: policy,
          remediation:
            "Finish the current global operation before mutating another global policy or app root.",
        }),
      );
    // Capturing the full body exit preserves failure roles outside coordination-error mapping.
    return yield* withAppMutationLock(
      { id: "global-policy", root: policy },
      withGlobalActivationScope(
        withAppMutationLock({ id: "global", root: paths.root }, Effect.exit(body)),
      ).pipe(Effect.provideService(HeldGlobalPolicy, { policy, root })),
      { lockRoot: dirname(policy) },
    );
  });
  const outcome = yield* coordinate.pipe(
    Effect.mapError(
      (cause) =>
        new GlobalAppError({
          operation: "coordination",
          message:
            cause instanceof AppLockTimeoutError
              ? "Another command is changing the global app."
              : "Unable to coordinate changes to the global app.",
          remediation: cause.remediation,
          cause,
        }),
    ),
  );
  return yield* outcome;
});
