import type { ServiceConnection, ServiceState } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

export const serviceState = (state: string): ServiceState => {
  switch (state) {
    case "stopped":
    case "starting":
    case "running":
    case "healthy":
    case "unhealthy":
    case "ready":
    case "completed":
    case "restarting":
    case "paused":
    case "error":
      return state;
    default:
      return "unknown";
  }
};

export const reconcileReadinessState = (
  readiness: ServiceState,
  runtime: ServiceRuntimeInfo,
): ServiceState => {
  const observed = serviceState(runtime.state ?? runtime.status);
  switch (observed) {
    case "running":
    case "healthy":
    case "ready":
      return readiness;
    case "stopped":
      return readiness === "completed" || readiness === "restarting" ? readiness : observed;
    case "unknown":
    case "starting":
    case "unhealthy":
    case "completed":
    case "restarting":
    case "paused":
    case "error":
      return observed;
    default: {
      const exhaustive: never = observed;
      return exhaustive;
    }
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
