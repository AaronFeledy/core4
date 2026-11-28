import { DateTime, Option, Schema } from "effect";
import { containerStartedAt, runStatusFromEngineState } from "../run-observation.ts";

const InspectState = Schema.Struct({
  Status: Schema.optionalKey(Schema.String),
  Running: Schema.optionalKey(Schema.Boolean),
  Paused: Schema.optionalKey(Schema.Boolean),
  Restarting: Schema.optionalKey(Schema.Boolean),
  Dead: Schema.optionalKey(Schema.Boolean),
  ExitCode: Schema.optionalKey(Schema.Unknown),
  StartedAt: Schema.optionalKey(Schema.String),
});

const StartInspect = Schema.Struct({
  State: InspectState,
  HostConfig: Schema.optionalKey(Schema.Unknown),
});

const RestartConfig = Schema.Struct({
  RestartPolicy: Schema.Struct({ Name: Schema.String }),
});

export const startObservation = (body: unknown) => {
  const decoded = Schema.decodeUnknownOption(StartInspect)(body);
  if (Option.isNone(decoded)) return { status: "unknown" as const };
  const { State: state, HostConfig } = decoded.value;
  const status = runStatusFromEngineState(state.Status);
  if (state.Paused === true || (state.Dead === true && status !== "dead"))
    return { status: "unknown" as const };
  if (
    status === "restarting" ||
    (status === "exited" && state.Restarting === true) ||
    (status === "running" && state.Restarting === true)
  ) {
    return { status: "restarting" as const };
  }
  if (state.Restarting === true || (status === "dead" && state.Running === true))
    return { status: "unknown" as const };
  if (status === "running" && state.Running !== false) return { status: "running" as const };
  if (state.Running === true) return { status: "unknown" as const };
  if (status !== "exited" && status !== "dead") return { status: "unknown" as const };
  const restart = Schema.decodeUnknownOption(RestartConfig)(HostConfig);
  const policy = Option.getOrUndefined(restart)?.RestartPolicy.Name;
  const startedAt = containerStartedAt(state);
  const since = startedAt === undefined ? undefined : DateTime.formatIso(startedAt);
  if (status === "dead") return { status, policy, exitCode: undefined, since };
  const exitCode =
    typeof state.ExitCode === "number" && Number.isSafeInteger(state.ExitCode) && state.ExitCode >= 0
      ? state.ExitCode
      : undefined;
  return { status, exitCode, policy, since };
};
