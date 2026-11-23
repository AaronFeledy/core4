import { StateStoreError } from "@lando/sdk/errors";
import type { StateRoot } from "@lando/sdk/services";
import { Effect } from "effect";

export const validateBucketSpec = (spec: {
  readonly root: StateRoot;
  readonly key: string;
  readonly version: number;
  readonly default?: unknown;
  readonly onCorrupt?: unknown;
  readonly onVersionMismatch?: unknown;
  readonly onNewerVersion?: unknown;
}): Effect.Effect<void, StateStoreError> => {
  if (!Number.isInteger(spec.version) || spec.version < 1 || spec.version > 0xffffffff) {
    return Effect.fail(
      new StateStoreError({
        reason: "version",
        operation: "open",
        remediation: `Declare an integer version from 1 through 4294967295 for bucket ${spec.key}.`,
      }),
    );
  }
  if (
    spec.root === "userCache" &&
    (!Object.hasOwn(spec, "default") ||
      (spec.onCorrupt !== undefined && spec.onCorrupt !== "discard" && spec.onCorrupt !== "quarantine") ||
      (spec.onVersionMismatch !== undefined && spec.onVersionMismatch !== "discard") ||
      (spec.onNewerVersion !== undefined && spec.onNewerVersion !== "discard"))
  ) {
    return Effect.fail(
      new StateStoreError({
        reason: "decode",
        operation: "open",
        remediation: `Cache bucket ${spec.key} requires a default, onCorrupt discard or quarantine, and discard for both version policies; use a durable root for non-regenerable state.`,
      }),
    );
  }
  return Effect.void;
};
