import { ProcessExecError, ServiceExecError } from "@lando/sdk/errors";

const checkCommandEffects =
  "The command may have finished or may still be running. Check what it changed before running it again.";

export class UnobservedServiceExit extends ServiceExecError {
  constructor(providerId: string, service: string) {
    super({
      providerId,
      operation: "exec",
      service,
      message: "Container exec ended without an observed exit status.",
      remediation: checkCommandEffects,
    });
  }
}

export const execExitUnobserved = (providerId: string, service: string): ServiceExecError =>
  new UnobservedServiceExit(providerId, service);

export class UnobservedProcessExit extends ProcessExecError {
  constructor() {
    super({
      cmd: "[unreported]",
      message: "The process stream ended without an observed exit status.",
      remediation: checkCommandEffects,
    });
  }
}

export const processExitUnobserved = (): ProcessExecError => new UnobservedProcessExit();
