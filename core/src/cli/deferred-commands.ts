/**
 * Deferred-command error projection from registry-owned command metadata.
 */
import { NotImplementedError } from "@lando/sdk/errors";
import type { LandoCommandSpec } from "./oclif/command-spec.ts";

export interface DeferredCommandPlan {
  readonly summary: string;
  readonly remediation: string;
}

export const notImplementedErrorForSpec = (spec: LandoCommandSpec): NotImplementedError => {
  const plan = spec.deferred;
  if (plan !== undefined) {
    return new NotImplementedError({
      message: `Command ${spec.id} is not implemented. ${plan.summary}`,
      commandId: spec.id,
      remediation: plan.remediation,
    });
  }
  return new NotImplementedError({
    message: `Command ${spec.id} is not implemented.`,
    commandId: spec.id,
    remediation: "This command is not available yet. Run `lando --help` to see currently available commands.",
  });
};
