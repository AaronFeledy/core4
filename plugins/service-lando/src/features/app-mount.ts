import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_APP_MOUNT_FEATURE_ID = "lando.app-mount" as const;
export const LANDO_APP_MOUNT_FEATURE_PRIORITY = 800;

export const landoAppMountFeature: ServiceFeatureDefinition = {
  id: LANDO_APP_MOUNT_FEATURE_ID,
  priority: LANDO_APP_MOUNT_FEATURE_PRIORITY,
  apply: () => Effect.void,
};
