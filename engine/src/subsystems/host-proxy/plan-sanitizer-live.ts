import { Layer } from "effect";

import { AppPlanSanitizer } from "@lando/sdk/services";

import { stripGpgAgentOverlay } from "../gpg-agent/overlay.ts";
import { stripSshAgentOverlay } from "../ssh-agent/overlay.ts";
import { stripHostProxyRunLando } from "./transport-feature.ts";

export const layer = Layer.succeed(
  AppPlanSanitizer,
  AppPlanSanitizer.of({
    sanitizeForPersistence: (plan) =>
      stripGpgAgentOverlay(stripSshAgentOverlay(stripHostProxyRunLando(plan))),
  }),
);
