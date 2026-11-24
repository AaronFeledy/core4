import type { ServiceHealthObservation, ServiceRunObservation } from "@lando/sdk/schema";
import { DateTime, Option } from "effect";

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
  readonly StartedAt?: string | undefined;
  readonly Health?:
    | {
        readonly Status?: string | undefined;
        // `Output` is never read: a check's output can carry secrets.
        readonly Log?: ReadonlyArray<{ readonly Start?: string; readonly End?: string }> | null | undefined;
      }
    | undefined;
}

const healthFromEngine = (state: EngineContainerState): ServiceHealthObservation | undefined => {
  const status = state.Health?.Status?.trim().toLowerCase();
  return status === "healthy" || status === "starting" || status === "unhealthy" ? status : undefined;
};

const epochMillis = (timestamp: string | undefined): number | undefined => {
  if (timestamp === undefined) return undefined;
  const parsed = DateTime.make(timestamp);
  return Option.isNone(parsed) ? undefined : DateTime.toEpochMillis(parsed.value);
};

/**
 * When the engine last finished a check in the current run: the `End` of the newest health-log
 * entry that started at or after `StartedAt`, as a UTC ISO-8601 string with millisecond precision.
 * Docker keeps the previous run's log across a restart, so an older entry is not evidence about
 * this run. Podman stamps entries in the host's local offset, so the engine spelling is not kept.
 */
const healthCheckedAtFromEngine = (state: EngineContainerState): string | undefined => {
  const startedAt = epochMillis(state.StartedAt);
  if (startedAt === undefined) return undefined;
  const ends = (state.Health?.Log ?? []).flatMap((entry) => {
    const start = epochMillis(entry.Start);
    const end = entry.End === undefined ? Option.none() : DateTime.make(entry.End);
    return start !== undefined && start >= startedAt && Option.isSome(end) ? [end.value] : [];
  });
  const last = ends.at(-1);
  return last === undefined ? undefined : DateTime.formatIso(last);
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
 * evidence of successful completion. `healthCheckedAt` accompanies `health` only.
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
      if (health === undefined) return { status };
      const healthCheckedAt = healthCheckedAtFromEngine(state);
      return healthCheckedAt === undefined ? { status, health } : { status, health, healthCheckedAt };
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
