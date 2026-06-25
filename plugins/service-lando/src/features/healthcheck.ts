import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_HEALTHCHECK_FEATURE_ID = "lando.healthcheck" as const;
export const LANDO_HEALTHCHECK_FEATURE_PRIORITY = 900;

export const landoHealthcheckFeature: ServiceFeatureDefinition = {
  id: LANDO_HEALTHCHECK_FEATURE_ID,
  priority: LANDO_HEALTHCHECK_FEATURE_PRIORITY,
  apply: () => Effect.void,
};
