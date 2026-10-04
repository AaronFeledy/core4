import { SshAgentTransportError } from "@lando/sdk/errors";
import { sshAgentEligibleServices } from "../subsystems/ssh-agent/overlay.ts";
import { resolveSshAgentIntent, sshAgentPlanExtension } from "../subsystems/ssh/intent.ts";
import { resolveStartAgentIntent } from "./start-agent-intent.ts";

export const resolveStartSshAgentIntent = resolveStartAgentIntent({
  label: "SSH",
  error: SshAgentTransportError,
  eligibleServices: sshAgentEligibleServices,
  planExtension: sshAgentPlanExtension,
  fallbackLandofile: (extension) => ({ sshAgent: { sidecar: extension.mode !== "host" } }),
  resolveIntent: resolveSshAgentIntent,
});
