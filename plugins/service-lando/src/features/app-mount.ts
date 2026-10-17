import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { AbsolutePath, PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { canonicalTarget, parseServiceMount } from "../services/_volume-helpers.ts";

export const LANDO_APP_MOUNT_FEATURE_ID = "lando.app-mount" as const;
export const LANDO_APP_MOUNT_FEATURE_PRIORITY = 800;

const AppMountConfig = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
  excludes: Schema.optionalKey(Schema.Array(Schema.String)),
  syncExcludes: Schema.optionalKey(Schema.Array(Schema.String)),
  includes: Schema.optionalKey(Schema.Array(Schema.String)),
  workingDirectory: Schema.optionalKey(Schema.String),
});

export const landoAppMountFeature: ServiceFeatureDefinition = {
  id: LANDO_APP_MOUNT_FEATURE_ID,
  schema: AppMountConfig,
  priority: LANDO_APP_MOUNT_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.try({
      try: () => {
        const config = ctx.config as typeof AppMountConfig.Type;
        const authoredMounts = (ctx.normalizedConfig.mounts ?? []).map((entry) =>
          parseServiceMount(entry, ctx.appRoot),
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
            excludes: [
              ...excludes,
              ...(authored?.excludes ?? []).filter((entry) => !excludes.includes(entry)),
            ],
            syncExcludes: [...new Set([...(config.syncExcludes ?? []), ...(authored?.syncExcludes ?? [])])],
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
      },
      catch: (cause) =>
        new ServiceFeatureError({
          feature: LANDO_APP_MOUNT_FEATURE_ID,
          message: cause instanceof Error ? cause.message : "lando.app-mount failed to apply",
          cause,
        }),
    }),
};
