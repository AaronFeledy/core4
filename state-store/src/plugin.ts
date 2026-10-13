import { Effect, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { type AbsolutePath, PluginStateLockOptions } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";

import { withAdvisoryLockUsing } from "./lock.ts";
import { resolveStatePath } from "./paths.ts";
import type { PrivateFileAccess } from "./private-file-access.ts";

export type { PluginStateBucketSpec, PluginStateStore } from "@lando/sdk/plugins";

const stateRootPathOf = (root: unknown): string | undefined => {
  if (typeof root !== "object" || root === null || !("path" in root)) return undefined;
  const path = root.path;
  return typeof path === "string" ? path : undefined;
};

export const makePluginStateStore = (
  store: StateStoreShape,
  pluginStateRoot: AbsolutePath,
  privateFileAccess: PrivateFileAccess,
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

  const withLock: PluginStateStore["withLock"] = (key, body, options) => {
    if (options !== undefined && !Schema.is(PluginStateLockOptions)(options)) {
      return Effect.fail(
        new StateStoreError({
          reason: "lock",
          operation: "withLock",
          path: pluginStateRoot,
          remediation: "Use a finite plugin lock wait from 0 to 600000 milliseconds.",
        }),
      );
    }

    return resolveStatePath({ path: pluginStateRoot }, "locks", key, "plugin-lock").pipe(
      Effect.flatMap(({ file }) =>
        withAdvisoryLockUsing(privateFileAccess, { expireLiveOwner: false })(
          file,
          "plugin-lock",
          body,
          options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        ),
      ),
    );
  };

  return { open, withLock };
};
