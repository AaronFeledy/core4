/**
 * Root-owned files under Lando's roots (usually from running lando with sudo) break later writes
 * with generic IO errors. Setup decides at planning, before any question, sudo prompt, or change,
 * what to do about them: when Lando can give every one back, it plans that as the run's first host
 * change; when any is one Lando will not touch (a hard link, an entry under a root its walker
 * refuses, or any entry outside Linux and WSL), setup fails at once with just those and the
 * command for each. After the repair, anything still root-owned, including what the walker left
 * on purpose or could not finish, fails setup before a later stage writes there.
 */
import { userInfo } from "node:os";

import { homeOfUid } from "@lando/engine/host/account-home";
import type { RootOwnedEntry } from "@lando/engine/host/root-ownership";
import { type HostChangeApplier, PathsService } from "@lando/sdk/services";
import { Effect, Result } from "effect";

import { landoInvocationPrefix } from "../../../recipes/prompts/choices-command";
import {
  REPAIR_ROOT_OWNERSHIP,
  type RootOwnershipRepairPlan,
  planRootOwnershipRepair,
  remainingRootOwnedMessage,
  rootOwnedManualCommands,
} from "../../host-changes/root-ownership-change";
import { RootOwnedLandoFilesError } from "./setup-steps";

const rootOwnedError = (entries: ReadonlyArray<RootOwnedEntry>, preface = "") =>
  new RootOwnedLandoFilesError({
    message: `${preface}${remainingRootOwnedMessage(entries.length)}`,
    paths: entries.map((entry) => entry.path),
    remediation: `Fix each one yourself, then rerun \`lando setup\` without sudo (Lando asks for administrator access itself when a step needs it):\n${rootOwnedManualCommands(entries)}`,
  });

/** The repair to plan, or nothing when every Lando file is the user's. */
export const planLandoRootsRepair = Effect.fnUntraced(function* () {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return undefined;
  // An account without a passwd entry still has its files repaired by uid. Its home comes from the
  // same lookup the walker makes as root, so the two never disagree; without one, nothing is planned.
  const account = Result.try(() => userInfo());
  const plan = yield* planRootOwnershipRepair({
    paths: yield* PathsService,
    uid,
    gid,
    user: Result.isSuccess(account) ? account.success.username : String(uid),
    platform: process.platform,
    home: homeOfUid(uid),
    invocation: landoInvocationPrefix(process.execPath, process.argv),
  });
  if (plan.manual.length > 0) return yield* Effect.fail(rootOwnedError(plan.manual));
  return plan.proposal === undefined ? undefined : plan;
});

/** Give the files back before anything writes under the roots, then check that none remain. */
export const applyLandoRootsRepair = Effect.fnUntraced(function* (
  hostChanges: HostChangeApplier,
  plan: RootOwnershipRepairPlan,
) {
  if (hostChanges.approved(REPAIR_ROOT_OWNERSHIP) === undefined) return;
  const outcome = yield* hostChanges.apply(REPAIR_ROOT_OWNERSHIP);
  const { rootOwned } = yield* plan.remaining;
  if (rootOwned.length > 0) {
    return yield* Effect.fail(
      rootOwnedError(
        rootOwned,
        outcome.outcome === "applied" ? "Lando gave back what it safely could. " : "",
      ),
    );
  }
});
