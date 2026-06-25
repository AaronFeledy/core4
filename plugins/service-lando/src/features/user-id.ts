import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_USER_ID_FEATURE_ID = "lando.user-id" as const;
export const LANDO_USER_ID_FEATURE_PRIORITY = 300;

export const landoUserIdFeature: ServiceFeatureDefinition = {
  id: LANDO_USER_ID_FEATURE_ID,
  priority: LANDO_USER_ID_FEATURE_PRIORITY,
  apply: () => Effect.void,
};
