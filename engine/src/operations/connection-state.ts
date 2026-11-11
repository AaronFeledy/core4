import type { ServiceConnection, ServiceRunObservation, ServiceState } from "@lando/sdk/schema";

/**
 * The one projection from a provider run observation to the shared service vocabulary. `lando
 * info` derives both `status` and `health.state` from the same observation, so a native health
 * verdict can only appear next to a running status.
 */
export const serviceStateOf = (run: ServiceRunObservation, completionIntent = false): ServiceState => {
  switch (run.status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "restarting":
      return "restarting";
    case "exited":
      return completionIntent && run.exitCode === 0 ? "completed" : "stopped";
    case "absent":
    case "created":
    case "dead":
    case "removing":
      return "stopped";
    case "unknown":
      return "unknown";
    default: {
      const exhaustive: never = run;
      return exhaustive;
    }
  }
};

export const reconcileReadinessState = (
  readiness: ServiceState,
  runtime: ServiceRunObservation,
): ServiceState => {
  const observed = serviceStateOf(runtime);
  switch (observed) {
    case "running":
      return readiness;
    case "stopped":
      return readiness === "completed" || readiness === "restarting" ? readiness : observed;
    case "unknown":
    case "starting":
    case "healthy":
    case "unhealthy":
    case "ready":
    case "completed":
    case "restarting":
    case "paused":
    case "error":
      return observed;
    default:
      return observed satisfies never;
  }
};

export const connectionActivity = (state: ServiceState): ServiceConnection["state"] => {
  switch (state) {
    case "running":
    case "healthy":
    case "ready":
    case "unhealthy":
      return "active";
    case "stopped":
    case "completed":
    case "paused":
    case "error":
      return "inactive";
    case "unknown":
    case "starting":
    case "restarting":
      return "unknown";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};
