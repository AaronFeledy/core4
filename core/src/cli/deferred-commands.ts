import { NotImplementedError } from "@lando/sdk/errors";
import type { LandoCommandSpec } from "./spec/command-spec";

export type DeferredCommandPhase = "4.1";

export interface DeferredCommandPlan {
  readonly summary: string;
  readonly remediation: string;
  readonly phase: DeferredCommandPhase;
}

export const notImplementedErrorForSpec = (spec: LandoCommandSpec): NotImplementedError => {
  const plan = spec.deferred;
  if (plan !== undefined) {
    return new NotImplementedError({
      message: `Command ${spec.id} is not implemented. ${plan.summary}`,
      commandId: spec.id,
      remediation: `${plan.remediation} Planned for Lando ${plan.phase}.`,
    });
  }
  return new NotImplementedError({
    message: `Command ${spec.id} is not implemented.`,
    commandId: spec.id,
    remediation: "This command is not available yet. Run `lando --help` to see currently available commands.",
  });
};
