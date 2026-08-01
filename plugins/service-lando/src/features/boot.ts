import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_BOOT_FEATURE_ID = "lando.boot" as const;
export const LANDO_BOOT_FEATURE_PRIORITY = 100;

export const landoBootFeature: ServiceFeatureDefinition = {
  id: LANDO_BOOT_FEATURE_ID,
  priority: LANDO_BOOT_FEATURE_PRIORITY,
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addBuildStep({
        id: "lando.boot:scaffold",
        phase: "build",
        command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
      });
    }),
};
