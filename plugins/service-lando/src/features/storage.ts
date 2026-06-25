import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_STORAGE_FEATURE_ID = "lando.storage" as const;
export const LANDO_STORAGE_FEATURE_PRIORITY = 500;

export const landoStorageFeature: ServiceFeatureDefinition = {
  id: LANDO_STORAGE_FEATURE_ID,
  priority: LANDO_STORAGE_FEATURE_PRIORITY,
  apply: () => Effect.void,
};
