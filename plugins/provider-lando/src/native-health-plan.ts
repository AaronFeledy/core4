import { HEALTH_START_INTERVAL_LABEL } from "@lando/container-runtime/labels";
import {
  type ManagedHealthRole,
  managedHealthRunKey,
} from "@lando/container-runtime/podman/managed-health-units";
import { DateTime, Option, Result, Schema } from "effect";

/** One running container's native healthcheck, as Lando's timers need it. */
export interface HealthRun {
  readonly containerId: string;
  /** Container id plus a digest of its full StartedAt; see `managedHealthRunKey`. */
  readonly key: string;
  readonly startedAtMs: number;
  readonly intervalMs: number;
  readonly startPeriodMs: number;
  readonly timeoutSeconds: number;
  /** Set only when Lando stamped a start interval at create, which Podman itself drops. */
  readonly startIntervalMs?: number;
}

export interface PlannedHealthTimer {
  readonly role: ManagedHealthRole;
  readonly firstMs: number;
  readonly cadenceMs: number;
  /** The main timer takes over from the start-phase timer once its run in progress ends. */
  readonly takesOverFromStart: boolean;
}

const nsToMs = (ns: number | undefined): number => Math.max(0, Math.floor((ns ?? 0) / 1_000_000));

const InspectedContainer = Schema.fromJsonString(
  Schema.Struct({
    Id: Schema.String,
    State: Schema.Struct({ Running: Schema.Boolean, StartedAt: Schema.String }),
    Config: Schema.Struct({
      Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
      Healthcheck: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            Test: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
            Interval: Schema.optionalKey(Schema.Number),
            Timeout: Schema.optionalKey(Schema.Number),
            StartPeriod: Schema.optionalKey(Schema.Number),
          }),
        ),
      ),
    }),
  }),
);

/**
 * The effective healthcheck of a libpod inspect body, image-inherited checks included. Undefined
 * when the container is not running or nothing should run on a schedule: no check, `NONE`, or
 * Podman's manual-only interval of 0.
 */
export const decodeHealthRun = (body: string): HealthRun | undefined => {
  const decoded = Schema.decodeUnknownResult(InspectedContainer)(body);
  if (Result.isFailure(decoded)) return undefined;
  const { Id, State, Config } = decoded.success;
  const check = Config.Healthcheck;
  const test = check?.Test ?? [];
  const startedAt = DateTime.make(State.StartedAt);
  const intervalMs = nsToMs(check?.Interval);
  if (
    !State.Running ||
    test.length === 0 ||
    test[0] === "NONE" ||
    intervalMs <= 0 ||
    Option.isNone(startedAt)
  )
    return undefined;
  const startIntervalMs = nsToMs(Number(Config.Labels?.[HEALTH_START_INTERVAL_LABEL]));
  return {
    containerId: Id,
    key: managedHealthRunKey(Id, State.StartedAt),
    startedAtMs: DateTime.toEpochMillis(startedAt.value),
    intervalMs,
    startPeriodMs: nsToMs(check?.StartPeriod),
    timeoutSeconds: Math.ceil(nsToMs(check?.Timeout) / 1000),
    ...(startIntervalMs > 0 ? { startIntervalMs } : {}),
  };
};

/**
 * Timers for one run. During the start period, a start interval gets its own timer and the main
 * timer first fires when the period ends, then hands over without overlapping a run in progress.
 * Otherwise the main timer first fires one interval out, as Docker's first probe does.
 */
export const healthTimerPlan = (run: HealthRun, nowMs: number): ReadonlyArray<PlannedHealthTimer> => {
  const remainingMs = run.startedAtMs + run.startPeriodMs - nowMs;
  if (run.startIntervalMs === undefined || remainingMs <= 0) {
    return [{ role: "main", firstMs: run.intervalMs, cadenceMs: run.intervalMs, takesOverFromStart: false }];
  }
  return [
    {
      role: "start",
      firstMs: run.startIntervalMs,
      cadenceMs: run.startIntervalMs,
      takesOverFromStart: false,
    },
    { role: "main", firstMs: remainingMs, cadenceMs: run.intervalMs, takesOverFromStart: true },
  ];
};
