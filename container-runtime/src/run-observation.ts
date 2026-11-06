import type { ServiceHealthObservation, ServiceRunObservation } from "@lando/sdk/schema";

/**
 * The engine-spelling to {@link ServiceRunObservation} boundary shared by every Docker-compatible
 * provider. Docker reports `created|running|paused|restarting|removing|exited|dead`; Podman adds
 * `configured`/`initialized` (never run) and `stopped` (terminated). Anything else, including a
 * transient `stopping`, is `unknown` rather than guessed.
 */
export const runStatusFromEngineState = (raw: string | undefined): ServiceRunObservation["status"] => {
  switch (raw?.trim().toLowerCase()) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "restarting":
      return "restarting";
    case "removing":
      return "removing";
    case "created":
    case "configured":
    case "initialized":
      return "created";
    case "exited":
    case "stopped":
      return "exited";
    case "dead":
      return "dead";
    default:
      return "unknown";
  }
};

export interface EngineContainerState {
  readonly Status?: string | undefined;
  readonly Running?: boolean | undefined;
  readonly Paused?: boolean | undefined;
  readonly Restarting?: boolean | undefined;
  readonly ExitCode?: number | undefined;
  readonly Health?: { readonly Status?: string | undefined } | undefined;
}

const healthFromEngine = (state: EngineContainerState): ServiceHealthObservation | undefined => {
  const status = state.Health?.Status?.trim().toLowerCase();
  return status === "healthy" || status === "starting" || status === "unhealthy" ? status : undefined;
};

/** Only a positive flag is evidence; `Running: false` alone does not prove the container exited. */
const runStatusFromFlags = (state: EngineContainerState): ServiceRunObservation["status"] => {
  if (state.Paused === true) return "paused";
  if (state.Restarting === true) return "restarting";
  if (state.Running === true) return "running";
  return "unknown";
};

/**
 * Normalizes a container-inspect `State` block. `Status` is authoritative when the engine sent it;
 * the boolean flags only stand in when it is absent. `health` survives only for a running
 * container and `exitCode` only for an exited one. A dead container's retained code is not
 * evidence of successful completion.
 */
export const runObservationFromInspectState = (
  state: EngineContainerState | undefined,
): ServiceRunObservation => {
  if (state === undefined) return { status: "unknown" };
  const status =
    state.Status === undefined || state.Status.length === 0
      ? runStatusFromFlags(state)
      : runStatusFromEngineState(state.Status);
  switch (status) {
    case "running": {
      const health = healthFromEngine(state);
      return health === undefined ? { status } : { status, health };
    }
    case "exited":
      return typeof state.ExitCode === "number" && Number.isInteger(state.ExitCode)
        ? { status, exitCode: state.ExitCode }
        : { status };
    case "absent":
    case "created":
    case "paused":
    case "restarting":
    case "dead":
    case "removing":
    case "unknown":
      return { status };
    default:
      return status satisfies never;
  }
};

/** Normalizes the `State` string of a container-list row, which carries no health or exit code. */
export const runObservationFromListState = (raw: string | undefined): ServiceRunObservation => ({
  status: runStatusFromEngineState(raw),
});
