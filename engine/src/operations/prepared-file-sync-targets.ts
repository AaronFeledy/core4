import { isDeepStrictEqual } from "node:util";

import { Effect, Schema } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import {
  type AppPlan,
  PreparedFileSyncTarget,
  type PreparedFileSyncTarget as PreparedFileSyncTargetType,
} from "@lando/sdk/schema";

const mismatch = (plan: AppPlan, message: string) =>
  new FileSyncStartError({
    engineId: plan.fileSync[0]?.engineId ?? "unknown",
    message,
    remediation:
      "Inspect the provider's prepared sync targets and retry with the complete planned session set.",
  });

/** Reject any target set that could direct a planned session to another volume. */
export const verifyPreparedFileSyncTargets = (
  plan: AppPlan,
  targets: ReadonlyArray<PreparedFileSyncTargetType>,
): Effect.Effect<void, FileSyncStartError> =>
  Effect.gen(function* () {
    if (plan.fileSync.length === 0 || !Array.isArray(targets) || targets.length !== plan.fileSync.length) {
      return yield* Effect.fail(
        mismatch(plan, "The provider did not prepare one target for every planned file-sync session."),
      );
    }
    const keys = new Set<string>();
    for (const { session } of plan.fileSync) {
      const key = JSON.stringify([session.service, session.mountKey]);
      if (keys.has(key)) {
        return yield* Effect.fail(mismatch(plan, "The file-sync plan has duplicate session identities."));
      }
      keys.add(key);
    }

    const endpointKeys = new Set<string>();
    const volumeNames = new Set<string>();
    for (const target of targets) {
      if (!Schema.is(PreparedFileSyncTarget)(target)) {
        return yield* Effect.fail(mismatch(plan, "The provider returned an invalid file-sync endpoint."));
      }
      const endpointKey = JSON.stringify([target.endpoint.containerId, target.endpoint.path]);
      if (endpointKeys.has(endpointKey) || volumeNames.has(target.endpoint.volumeName)) {
        return yield* Effect.fail(
          mismatch(plan, "The provider returned duplicate file-sync endpoint identities."),
        );
      }
      endpointKeys.add(endpointKey);
      volumeNames.add(target.endpoint.volumeName);
    }

    const remaining = [...targets];
    for (const { session } of plan.fileSync) {
      const match = remaining.findIndex((target) => isDeepStrictEqual(target.session, session));
      if (match < 0) {
        return yield* Effect.fail(
          mismatch(plan, "A planned file-sync session has no exact prepared target."),
        );
      }
      const [prepared] = remaining.splice(match, 1);
      if (
        prepared === undefined ||
        !Schema.is(PreparedFileSyncTarget)(prepared) ||
        session.target._tag !== "volume" ||
        prepared.endpoint.volumeName !== session.target.name
      ) {
        return yield* Effect.fail(
          mismatch(plan, "A prepared file-sync endpoint does not match its planned volume."),
        );
      }
    }
    if (remaining.length !== 0) {
      return yield* Effect.fail(mismatch(plan, "The provider returned an unplanned file-sync target."));
    }
  });
