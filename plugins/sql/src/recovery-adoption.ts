import { Effect } from "effect";

import type { SqlPhysicalContextInput, SqlPhysicalLockTarget } from "./recovery-target.ts";
import { resolvePhysicalTarget } from "./recovery-target.ts";
import { recoveryUnavailable, sameRuntime } from "./runtime-observation.ts";

const samePhysicalBinding = (left: SqlPhysicalLockTarget, right: SqlPhysicalLockTarget): boolean =>
  left.coordinationKey === right.coordinationKey &&
  left.volume.ref.store === right.volume.ref.store &&
  sameRuntime(left.runtime, right.runtime);

export const resolveLockedPhysicalTarget = (
  input: SqlPhysicalContextInput,
  initial: SqlPhysicalLockTarget,
  locked: SqlPhysicalLockTarget,
) =>
  Effect.gen(function* () {
    if (!samePhysicalBinding(initial, locked)) {
      return yield* Effect.fail(
        recoveryUnavailable(
          input.serviceName,
          "The acquired lock belongs to a different volume or runtime instance.",
          "Retry after the concurrent lifecycle operation completes.",
        ),
      );
    }
    if (initial._tag === "identified") {
      if (
        locked._tag !== "identified" ||
        locked.identity.generation !== initial.identity.generation ||
        locked.identity.ownerRoot !== initial.identity.ownerRoot ||
        locked.identity.nativeName !== initial.identity.nativeName
      ) {
        return yield* Effect.fail(
          recoveryUnavailable(
            input.serviceName,
            "The acquired lock belongs to a different volume generation.",
            "Retry after the concurrent lifecycle operation completes.",
          ),
        );
      }
      return locked;
    }
    if (locked._tag === "identified") {
      if (locked.identity.origin !== "adopted") {
        return yield* Effect.fail(
          recoveryUnavailable(
            input.serviceName,
            "The legacy volume gained conflicting creation identity while acquiring its lock.",
            "Inspect the mounted native volume before retrying `lando db:snapshot`.",
          ),
        );
      }
      return locked;
    }
    const adopt = input.deps.adoptVolume;
    if (adopt === undefined) {
      return yield* Effect.fail(
        recoveryUnavailable(
          input.serviceName,
          "The selected provider cannot adopt this legacy volume.",
          "Create a logical export before mutating this database.",
        ),
      );
    }
    yield* adopt(input.serviceName, locked.mountStore, locked.mountTarget);
    const adopted = yield* resolvePhysicalTarget({ ...input, adoptLegacy: false });
    if (
      adopted._tag !== "identified" ||
      adopted.identity.origin !== "adopted" ||
      !samePhysicalBinding(locked, adopted)
    ) {
      return yield* Effect.fail(
        recoveryUnavailable(
          input.serviceName,
          "The adopted volume could not be re-observed with the elected witness identity.",
          "Leave the database unchanged and inspect its mounted volume before retrying.",
        ),
      );
    }
    const initialization = yield* input.deps.initialization(adopted.identity);
    if ((yield* initialization.read) !== null) {
      return yield* Effect.fail(
        recoveryUnavailable(
          input.serviceName,
          "The adopted volume conflicts with existing initialization history.",
          "Create a logical export instead of treating this existing database as fresh.",
        ),
      );
    }
    return adopted;
  });
