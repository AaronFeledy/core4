import type { AppPlan, GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

export const GPG_AGENT_PLAN_EXTENSION_KEY = "@lando/core/gpg-agent";
const GpgAgentPlanExtension = Schema.Struct({ forward: Schema.Boolean });
export type GpgAgentIntent = typeof GpgAgentPlanExtension.Type & { readonly socket?: string };

export const resolveGpgAgentIntent = (input: {
  readonly landofile: Pick<LandofileShape, "gpgAgent">;
  readonly globalConfig?: Pick<GlobalConfig, "gpgAgent"> | undefined;
}): GpgAgentIntent => {
  const forward = input.landofile.gpgAgent?.forward ?? input.globalConfig?.gpgAgent?.forward ?? false;
  const socket = input.landofile.gpgAgent?.socket ?? input.globalConfig?.gpgAgent?.socket;
  return { forward, ...(socket === undefined ? {} : { socket }) };
};

export const gpgAgentPlanExtension = (plan: Pick<AppPlan, "extensions">) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(GpgAgentPlanExtension)(plan.extensions[GPG_AGENT_PLAN_EXTENSION_KEY]),
  );
