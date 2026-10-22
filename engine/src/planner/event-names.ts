import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { AppLifecycleEventName } from "@lando/sdk/schema";
import { reservedTopLevelAliasOwner } from "../operations/reserved-aliases.ts";
import type { EffectiveTooling } from "./effective-tooling.ts";

// Reserved for remote sync whether or not a remote connector is installed, so
// an authored hook keeps working once one is.
const REMOTE_HOOK_EVENT_NAMES = ["post-pull", "post-push", "post-switch", "post-code-sync"] as const;

const RESERVED_EVENT_NAMES: ReadonlySet<string> = new Set([
  ...AppLifecycleEventName.literals,
  ...REMOTE_HOOK_EVENT_NAMES,
]);

/** The reserved app or remote-hook events a tooling task's brackets would also bind. */
export const reservedEventCollisions = (taskName: string): ReadonlyArray<string> =>
  [`pre-${taskName}`, `post-${taskName}`].filter((event) => RESERVED_EVENT_NAMES.has(event));

export const validEventNames = (effectiveTooling: EffectiveTooling): ReadonlyArray<string> => {
  const internal = new Set(getInternalToolingTasks(effectiveTooling));
  const brackets = Object.keys(effectiveTooling)
    .filter((name) => !internal.has(name) && reservedTopLevelAliasOwner(name) === undefined)
    .flatMap((name) => [`pre-${name}`, `post-${name}`])
    .sort();
  return [...new Set([...RESERVED_EVENT_NAMES, ...brackets])];
};
