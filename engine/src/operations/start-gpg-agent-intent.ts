import { GpgAgentTransportError } from "@lando/sdk/errors";
import { gpgAgentPlanExtension, resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { gpgAgentEligibleServices } from "../subsystems/gpg-agent/overlay.ts";
import { resolveStartAgentIntent } from "./start-agent-intent.ts";

export const resolveStartGpgAgentIntent = resolveStartAgentIntent({
  label: "GPG",
  error: GpgAgentTransportError,
  eligibleServices: gpgAgentEligibleServices,
  planExtension: gpgAgentPlanExtension,
  fallbackLandofile: (extension) => ({ gpgAgent: { forward: extension.forward } }),
  resolveIntent: resolveGpgAgentIntent,
});
