import { Effect } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";

import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { resolveStatePath } from "@lando/state-store/paths";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { ownerOnlyFileAccess } from "../services/private-file-access.ts";

export type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";

const stateRootPathOf = (root: unknown): string | undefined => {
  if (typeof root !== "object" || root === null || !("path" in root)) return undefined;
  const path = root.path;
  return typeof path === "string" ? path : undefined;
};

export const makePluginStateStore = (
  store: StateStoreShape,
  pluginStateRoot: AbsolutePath,
  privateFileAccess: PrivateFileAccess = ownerOnlyFileAccess,
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
      Effect.flatMap(({ file }) => withAdvisoryLockUsing(privateFileAccess)(file, "plugin-lock", body)),
    );

  return { open, withLock };
};
