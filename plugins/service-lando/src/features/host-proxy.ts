import { Effect } from "effect";

import type { ServiceFeatureDefinition } from "@lando/sdk/services";

export const LANDO_HOST_PROXY_FEATURE_ID = "lando.host-proxy" as const;
export const LANDO_HOST_PROXY_FEATURE_PRIORITY = 1250;

export const landoHostProxyFeature: ServiceFeatureDefinition = {
  id: LANDO_HOST_PROXY_FEATURE_ID,
  priority: LANDO_HOST_PROXY_FEATURE_PRIORITY,
  requires: ["hostReachability"],
  apply: () => Effect.void,
};
