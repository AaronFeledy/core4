import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { StateRoot } from "@lando/sdk/services";

export const validateCacheSpec = (spec: {
  readonly root: StateRoot;
  readonly key: string;
  readonly default?: unknown;
  readonly onCorrupt?: unknown;
  readonly onVersionMismatch?: unknown;
}): Effect.Effect<void, StateStoreError> =>
  spec.root === "userCache" &&
  (!Object.hasOwn(spec, "default") ||
    (spec.onCorrupt !== undefined && spec.onCorrupt !== "discard" && spec.onCorrupt !== "quarantine") ||
    (spec.onVersionMismatch !== undefined && spec.onVersionMismatch !== "discard"))
    ? Effect.fail(
        new StateStoreError({
          reason: "decode",
          operation: "open",
          remediation: `Cache bucket ${spec.key} requires a default, onCorrupt discard or quarantine, and onVersionMismatch discard; use a durable root for non-regenerable state.`,
        }),
      )
    : Effect.void;
