import { Cron, Result, Schema } from "effect";

import { layerMerge } from "./layer-merge.ts";
import { CommandSpec, ContainerUser } from "./primitives.ts";

const REPLACE = { kind: "replace" } as const;

const CRON_MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
} as const;

const GO_DURATION_PIECE = /^(?:(?:0|[1-9]\d*)(?:ns|us|µs|μs|ms|s|m|h))+$/u;
const EVERY_PREFIX = /^@every\s+/u;

const cronExpressionMessage =
  'Expected a 5-field cron expression, a named schedule (@hourly, @daily, @weekly, @monthly, @yearly, @annually, @midnight), or @every with a whole number of seconds (1-59), minutes (1-59), or hours (1-23) such as "1s", "5m", or "1h".';

/** Parse a Go duration used by `@every`, returning milliseconds when the spec is positive. */
export const parseEveryDurationMs = (value: string): number | undefined => {
  const body = value.trim().replace(EVERY_PREFIX, "");
  if (body.length === 0 || !GO_DURATION_PIECE.test(body)) return undefined;
  const piece = /(\d+)(ns|us|µs|μs|ms|s|m|h)/gu;
  let totalNs = 0n;
  let consumed = 0;
  for (const match of body.matchAll(piece)) {
    if (match.index !== consumed) return undefined;
    consumed += match[0].length;
    const amount = BigInt(match[1] ?? "0");
    const unit = match[2];
    const factor =
      unit === "h"
        ? 3_600_000_000_000n
        : unit === "m"
          ? 60_000_000_000n
          : unit === "s"
            ? 1_000_000_000n
            : unit === "ms"
              ? 1_000_000n
              : unit === "us" || unit === "µs" || unit === "μs"
                ? 1_000n
                : 1n;
    totalNs += amount * factor;
  }
  if (consumed !== body.length || totalNs <= 0n) return undefined;
  const ms = totalNs / 1_000_000n;
  return ms > 0n ? Number(ms) : 1;
};

/** True when `@every` is a whole number of seconds (1-59), minutes (1-59), or hours (1-23). */
export const isMappableEveryDurationMs = (ms: number): boolean => {
  if (!Number.isInteger(ms) || ms < 1000) return false;
  const seconds = ms / 1000;
  if (!Number.isInteger(seconds) || seconds < 1) return false;
  if (seconds < 60) return true;
  if (seconds % 60 !== 0) return false;
  const minutes = seconds / 60;
  if (minutes < 60) return true;
  if (minutes % 60 !== 0) return false;
  const hours = minutes / 60;
  return Number.isInteger(hours) && hours >= 1 && hours < 24;
};

export const isEveryCronExpression = (value: string): boolean => {
  const ms = parseEveryDurationMs(value);
  return ms !== undefined && isMappableEveryDurationMs(ms);
};

export const expandCronMacro = (value: string): string => {
  const trimmed = value.trim();
  return Object.hasOwn(CRON_MACROS, trimmed) ? CRON_MACROS[trimmed as keyof typeof CRON_MACROS] : trimmed;
};

export const isCronExpression = (value: string): boolean => {
  const trimmed = value.trim();
  if (Object.hasOwn(CRON_MACROS, trimmed)) return true;
  if (EVERY_PREFIX.test(trimmed)) return isEveryCronExpression(trimmed);
  return Result.isSuccess(Cron.parse(trimmed));
};

export const CronExpression = Schema.String.check(
  Schema.makeFilter((value: string) => (isCronExpression(value) ? undefined : cronExpressionMessage)),
).annotate({
  identifier: "CronExpression",
  title: "Cron Expression",
  description:
    "Five-field cron expression, a named schedule such as @hourly, or @every with a whole number of seconds, minutes, or hours.",
  expected: "a cron expression",
  message: cronExpressionMessage,
});
export type CronExpression = typeof CronExpression.Type;

const SCHEDULE_JOB_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

export const ScheduleJobName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isPattern(SCHEDULE_JOB_NAME_PATTERN)),
).annotate({
  identifier: "ScheduleJobName",
  title: "Schedule Job Name",
  description:
    "Job name unique within the service. Letters, digits, underscores, and hyphens; must start with a letter.",
});
export type ScheduleJobName = typeof ScheduleJobName.Type;

export const ScheduleJob = Schema.Struct({
  name: ScheduleJobName,
  every: CronExpression.annotate({
    description:
      "When the job runs: a 5-field cron expression, a named schedule, or @every with a whole number of seconds, minutes, or hours.",
  }),
  run: CommandSpec.annotate({
    description: "Command the job runs, as a shell string or argv array.",
  }),
  user: Schema.optionalKey(ContainerUser).annotate({
    description: "Container user the job runs as. Defaults to the parent service user.",
  }),
}).annotate({
  identifier: "ScheduleJob",
  title: "Schedule Job",
  description: "One scheduled command on a service, identified by a name unique within that service.",
});
export type ScheduleJob = typeof ScheduleJob.Type;

const uniqueScheduleJobNames = Schema.makeFilter((jobs: ReadonlyArray<ScheduleJob>) => {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.name)) {
      return `Schedule job name "${job.name}" is already used on this service. Choose a unique name.`;
    }
    seen.add(job.name);
  }
  return undefined;
});

export const ScheduleConfig = layerMerge(Schema.Array(ScheduleJob), REPLACE)
  .check(uniqueScheduleJobNames)
  .annotate({
    identifier: "ScheduleConfig",
    title: "Schedule",
    description: "Scheduled jobs for a service. Names must be unique within the service.",
  });
export type ScheduleConfig = typeof ScheduleConfig.Type;
