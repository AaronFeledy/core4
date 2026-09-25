import { Layer } from "effect";

import { AppPlanSanitizer } from "@lando/sdk/services";

import { stripAgentSocketOverlay, stripSshAgentOverlay } from "../ssh-agent/overlay.ts";
import { stripHostProxyRunLando } from "./transport-feature.ts";

export const AppPlanSanitizerLive = Layer.succeed(AppPlanSanitizer, {
  sanitizeForPersistence: (plan) =>
    stripAgentSocketOverlay(stripSshAgentOverlay(stripHostProxyRunLando(plan)), "gpg"),
});
