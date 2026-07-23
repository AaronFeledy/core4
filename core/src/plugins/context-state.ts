import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { StateBucket, StateBucketSpec, StateStoreShape } from "@lando/sdk/services";

import { withAdvisoryLock } from "../state/lock.ts";
import { resolveStatePath } from "../state/paths.ts";

export type PluginStateBucketSpec<A, I> = Omit<StateBucketSpec<A, I>, "root">;

export interface PluginStateStore {
  readonly open: <A, I>(spec: PluginStateBucketSpec<A, I>) => Effect.Effect<StateBucket<A>, StateStoreError>;
  /** Run an asynchronous critical section under a plugin-confined cross-process advisory lock. */
  readonly withLock: <A, E>(key: string, body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
}

const stateRootPathOf = (root: unknown): string | undefined => {
  if (typeof root !== "object" || root === null || !("path" in root)) return undefined;
  const path = root.path;
  return typeof path === "string" ? path : undefined;
};

export const makePluginStateStore = (
  store: StateStoreShape,
  pluginStateRoot: AbsolutePath,
): PluginStateStore => {
  const open: PluginStateStore["open"] = (spec) => {
    if ("root" in spec && stateRootPathOf(spec.root) !== pluginStateRoot) {
      return Effect.fail(
        new StateStoreError({
          reason: "path",
          operation: "open",
          path: pluginStateRoot,
          remediation: "Plugins are confined to their host-assigned durable-state subtree.",
        }),
      );
    }
    return store.open({ ...spec, root: { path: pluginStateRoot } });
  };

  const withLock: PluginStateStore["withLock"] = (key, body) =>
    resolveStatePath({ path: pluginStateRoot }, "locks", key, "plugin-lock").pipe(
      Effect.flatMap(({ file }) => withAdvisoryLock(file, "plugin-lock", body)),
    );

  return { open, withLock };
};
