import { Schema } from "effect";

// ============================================================================
// Provider-normalized run state of one service container.
// ============================================================================

/** Container-engine healthcheck verdict; it exists only while the container is running. */
export const ServiceHealthObservation = Schema.Literals(["healthy", "starting", "unhealthy"]).annotate({
  identifier: "ServiceHealthObservation",
  description: "Native container healthcheck verdict reported by the runtime provider.",
});
export type ServiceHealthObservation = typeof ServiceHealthObservation.Type;

const RunningServiceRun = Schema.Struct({
  status: Schema.Literal("running"),
  health: Schema.optionalKey(ServiceHealthObservation),
  exitCode: Schema.optionalKey(Schema.Never),
});

const ExitedServiceRun = Schema.Struct({
  status: Schema.Literal("exited"),
  exitCode: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  health: Schema.optionalKey(Schema.Never),
});

const IdleServiceRun = Schema.Struct({
  status: Schema.Literals(["absent", "created", "paused", "restarting", "dead", "removing", "unknown"]),
  health: Schema.optionalKey(Schema.Never),
  exitCode: Schema.optionalKey(Schema.Never),
});

/**
 * One closed run-state observation, normalized once at the provider boundary. `health` is only
 * representable while `running` and `exitCode` only once the container has `exited`,
 * so a record cannot claim a stopped-but-healthy or running-with-exit-code container.
 *
 * - `absent`: the provider found no container for the service.
 * - `created`: the container exists but has never run.
 * - `removing`: the engine is deleting the container.
 * - `dead`: the engine cannot manage the container; an old exit code is not completion evidence.
 * - `unknown`: the engine reported a state outside this set, or the container is not provably this
 *   service's; consumers must not treat it as stopped.
 */
export const ServiceRunObservation = Schema.Union([RunningServiceRun, ExitedServiceRun, IdleServiceRun]);
export type ServiceRunObservation = typeof ServiceRunObservation.Type;

export type ServiceRunStatus = ServiceRunObservation["status"];

/** True while the container holds runtime resources: it is running, paused, or restarting. */
export const isActiveRunStatus = (status: ServiceRunStatus): boolean =>
  status === "running" || status === "paused" || status === "restarting";

/** True when the container is provably not executing: absent, never started, or terminated. */
export const isIdleRunStatus = (status: ServiceRunStatus): boolean =>
  status === "absent" || status === "created" || status === "exited" || status === "dead";
