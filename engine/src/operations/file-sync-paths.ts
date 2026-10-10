import { sameRealpath } from "@lando/paths/realpath-equivalence";
import type { FileSyncSessionSpec } from "@lando/sdk/schema";

/** Compare every setting that can change which bytes a session reads or writes. */
export const sameFileSyncSessionSpec = (
  planned: FileSyncSessionSpec,
  actual: FileSyncSessionSpec | undefined,
): boolean => {
  if (actual === undefined) return false;
  if (
    planned.app.kind !== actual.app.kind ||
    planned.app.id !== actual.app.id ||
    !sameRealpath(planned.app.root, actual.app.root) ||
    planned.service !== actual.service ||
    planned.mountKey !== actual.mountKey ||
    !sameRealpath(planned.source, actual.source) ||
    planned.mode !== actual.mode ||
    planned.target._tag !== actual.target._tag ||
    planned.target.path !== actual.target.path ||
    planned.excludes.length !== actual.excludes.length ||
    planned.excludes.some((exclude, index) => exclude !== actual.excludes[index]) ||
    (planned.permissions === undefined) !== (actual.permissions === undefined) ||
    planned.permissions?.owner !== actual.permissions?.owner ||
    planned.permissions?.mode !== actual.permissions?.mode
  )
    return false;
  return planned.target._tag === "volume"
    ? actual.target._tag === "volume" && planned.target.name === actual.target.name
    : actual.target._tag === "service" && planned.target.service === actual.target.service;
};
