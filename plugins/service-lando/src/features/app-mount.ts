import { Schema } from "effect";

import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { serviceFeatureApply } from "../services/_feature-helpers.ts";
import { canonicalTarget, parseServiceMount } from "../services/_volume-helpers.ts";

export const LANDO_APP_MOUNT_FEATURE_ID = "lando.app-mount" as const;
export const LANDO_APP_MOUNT_FEATURE_PRIORITY = 800;

const AppMountConfig = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
  excludes: Schema.optionalKey(Schema.Array(Schema.String)),
  includes: Schema.optionalKey(Schema.Array(Schema.String)),
  workingDirectory: Schema.optionalKey(Schema.String),
});

export const landoAppMountFeature: ServiceFeatureDefinition = {
  id: LANDO_APP_MOUNT_FEATURE_ID,
  schema: AppMountConfig,
  priority: LANDO_APP_MOUNT_FEATURE_PRIORITY,
  apply: serviceFeatureApply(LANDO_APP_MOUNT_FEATURE_ID, "lando.app-mount failed to apply", (ctx) => {
    const config = ctx.config as typeof AppMountConfig.Type;
    const authoredMounts = (ctx.normalizedConfig.mounts ?? []).map((entry, index) =>
      parseServiceMount(entry, ctx.appRoot, index),
    );
    for (const mount of authoredMounts) {
      ctx.addMount({
        type: mount.type,
        ...(mount.source === undefined ? {} : { source: mount.source }),
        target: PortablePath.make(mount.target),
        readOnly: mount.readOnly,
      });
    }
    if (config.target === undefined) return;
    const authored = ctx.normalizedConfig.appMount;
    if (authored === false) {
      if (ctx.base === "lando" && ctx.normalizedConfig.workingDirectory !== undefined) {
        ctx.setWorkingDirectory(PortablePath.make(ctx.normalizedConfig.workingDirectory));
      }
      return;
    }
    const target = PortablePath.make(canonicalTarget(authored?.target ?? config.target));
    const replaced = authoredMounts.some((mount) => canonicalTarget(mount.target) === target);
    if (!replaced) {
      const excludes = config.excludes ?? [];
      ctx.setAppMount({
        source: AbsolutePath.make(ctx.appRoot),
        target,
        readOnly: authored?.readOnly ?? config.readOnly ?? false,
        excludes: [...excludes, ...(authored?.excludes ?? []).filter((entry) => !excludes.includes(entry))],
        includes: [...new Set([...(config.includes ?? []), ...(authored?.includes ?? [])])],
      });
    }
    if (ctx.base === "lando") {
      ctx.addEnv("LANDO_APP_ROOT", target);
      ctx.addEnv("LANDO_PROJECT_MOUNT", target);
      ctx.setWorkingDirectory(
        PortablePath.make(ctx.normalizedConfig.workingDirectory ?? config.workingDirectory ?? target),
      );
    }
  }),
};
