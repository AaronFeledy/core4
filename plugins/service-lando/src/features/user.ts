import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_USER_FEATURE_ID = "lando.user" as const;
export const LANDO_USER_FEATURE_PRIORITY = 2000;

export const landoUserFeature: ServiceFeatureDefinition = {
  id: LANDO_USER_FEATURE_ID,
  priority: LANDO_USER_FEATURE_PRIORITY,
  apply: () => Effect.void,
};
