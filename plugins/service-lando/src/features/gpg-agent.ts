import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect } from "effect";

export const landoGpgAgentFeature: ServiceFeatureDefinition = {
  id: "lando.gpg-agent",
  priority: 1210,
  requires: ["agentSocket"],
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addExtension("@lando/core/gpg-agent", { forward: true });
    }),
};
