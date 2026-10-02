import type { ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

export const LANDO_SSH_AGENT_FEATURE_ID = "lando.ssh-agent";
export const LANDO_SSH_AGENT_FEATURE_PRIORITY = 1200;

const LandoSshAgentFeatureConfig = Schema.Struct({
  mode: Schema.Literals(["sidecar", "host"]).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => "sidecar" as const)),
  ),
});

export const landoSshAgentFeature: ServiceFeatureDefinition = {
  id: LANDO_SSH_AGENT_FEATURE_ID,
  priority: LANDO_SSH_AGENT_FEATURE_PRIORITY,
  schema: Schema.make(LandoSshAgentFeatureConfig.ast),
  requires: ["agentSocket"],
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addExtension("@lando/core/ssh-agent", { mode: ctx.config.mode });
    }),
};
