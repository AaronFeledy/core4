import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { StateBucket, StateBucketSpec, StateStoreShape } from "@lando/sdk/services";

export type PluginStateBucketSpec<A, I> = Omit<StateBucketSpec<A, I>, "root">;

export interface PluginStateStore {
  readonly open: <A, I>(spec: PluginStateBucketSpec<A, I>) => Effect.Effect<StateBucket<A>, StateStoreError>;
}

const stateRootPathOf = (root: unknown): string | undefined => {
  if (typeof root !== "object" || root === null || !("path" in root)) return undefined;
  const path = root.path;
  return typeof path === "string" ? path : undefined;
};

const pluginStatePathError = (pluginStateRoot: AbsolutePath): StateStoreError =>
  new StateStoreError({
    reason: "path",
    operation: "open",
    path: pluginStateRoot,
    remediation: "Plugins are confined to their host-assigned durable-state subtree.",
  });

export const makePluginStateStore = (
  store: StateStoreShape,
  pluginStateRoot: AbsolutePath,
): PluginStateStore => {
  const open: PluginStateStore["open"] = (spec) => {
    if ("root" in spec && stateRootPathOf(spec.root) !== pluginStateRoot) {
      return Effect.fail(pluginStatePathError(pluginStateRoot));
    }
    return store.open({ ...spec, root: { path: pluginStateRoot } });
  };

  return { open };
};
