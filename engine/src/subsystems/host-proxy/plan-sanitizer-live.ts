import { Layer } from "effect";

import { AppPlanSanitizer } from "@lando/sdk/services";

import { stripSshAgentOverlay } from "../ssh-agent/overlay.ts";
import { stripHostProxyRunLando } from "./transport-feature.ts";

export const AppPlanSanitizerLive = Layer.succeed(AppPlanSanitizer, {
  sanitizeForPersistence: (plan) => stripSshAgentOverlay(stripHostProxyRunLando(plan)),
});
