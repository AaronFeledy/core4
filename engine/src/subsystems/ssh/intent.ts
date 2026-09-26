import type { AppPlan, GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

export const SSH_AGENT_PLAN_EXTENSION_KEY = "@lando/core/ssh-agent";

const SshAgentPlanExtension = Schema.Struct({ mode: Schema.Literal("sidecar", "host") });
export type SshAgentPlanExtension = typeof SshAgentPlanExtension.Type;
export type SshAgentIntent = SshAgentPlanExtension & { readonly socket?: string };

export const resolveSshAgentIntent = (input: {
  readonly landofile: Pick<LandofileShape, "sshAgent">;
  readonly globalConfig?: Pick<GlobalConfig, "sshAgent"> | undefined;
}): SshAgentIntent => {
  const sidecar = input.landofile.sshAgent?.sidecar ?? input.globalConfig?.sshAgent?.sidecar ?? true;
  const socket = input.landofile.sshAgent?.socket ?? input.globalConfig?.sshAgent?.socket;
  return { mode: sidecar ? "sidecar" : "host", ...(socket === undefined ? {} : { socket }) };
};

export const sshAgentExtensionForIntent = (intent: SshAgentIntent): SshAgentPlanExtension => ({
  mode: intent.mode,
});

export const sshAgentPlanExtension = (plan: Pick<AppPlan, "extensions">): SshAgentPlanExtension | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(SshAgentPlanExtension)(plan.extensions[SSH_AGENT_PLAN_EXTENSION_KEY]),
  );
