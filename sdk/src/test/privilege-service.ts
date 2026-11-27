import { Effect } from "effect";
import type { PrivilegeError } from "../errors/index.ts";
import type { PrivilegeService, PrivilegeSession } from "../services/process.ts";

export interface TestPrivilegeServiceOptions {
  /** Runs each elevated command, as root would. */
  readonly elevate: PrivilegeSession["elevate"];
  /** Observes or refuses opening a session; succeeds by default. */
  readonly open?: (purpose: string) => Effect.Effect<void, PrivilegeError>;
}

/**
 * A `PrivilegeService` for tests that never runs sudo: it reports `root`, and every session and
 * one-off elevation runs through `elevate`.
 */
export const makeTestPrivilegeService = (
  options: TestPrivilegeServiceOptions,
): typeof PrivilegeService.Service => {
  const open = options.open ?? (() => Effect.void);
  const session: PrivilegeSession = { transport: "direct", elevate: options.elevate };
  return {
    credentialStatus: Effect.succeed({ state: "root" }),
    openSession: (purpose) => Effect.as(open(purpose), session),
    elevate: (command, elevateOptions) =>
      open(`run ${command[0] ?? "a command"}`).pipe(Effect.andThen(options.elevate(command, elevateOptions))),
  };
};
