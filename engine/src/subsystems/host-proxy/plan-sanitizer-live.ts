import { Layer } from "effect";

import { AppPlanSanitizer } from "@lando/sdk/services";

import { stripHostProxyRunLando } from "./transport-feature.ts";

export const AppPlanSanitizerLive = Layer.succeed(AppPlanSanitizer, {
  sanitizeForPersistence: stripHostProxyRunLando,
});
