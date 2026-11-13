import { Cron, Result, Schema } from "effect";

import { executionSiteKey } from "./execution-site.ts";
import { layerMerge } from "./layer-merge.ts";
import { CommandSpec, ContainerUser } from "./primitives.ts";

// ============================================================================
// Cron cadence: named schedules, clock-aligned @every steps, 5-field cron.
// ============================================================================

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
const CRON_FIELD_COUNT = 5;

const cronExpressionMessage =
  'Expected a 5-field cron expression, a named schedule (@hourly, @daily, @weekly, @monthly, @yearly, @annually, @midnight), or @every with seconds or minutes that divide 60, or hours that divide 24, such as "1s", "5m", or "1h".';

const everyStepMessage =
  "@every compiles to crontab */N, which only means every N when seconds and minutes divide 60 and hours divide 24. Use a 5-field cron expression instead.";

/**
 * Parse a Go duration used by `@every`. Accepts a value with or without the
 * `@every ` prefix and returns its positive length in milliseconds, or
 * `undefined` when the text is not one positive Go duration with no
 * sub-millisecond remainder: the crontab can only express whole seconds, so
 * truncating `1s1ns` to `1s` would schedule something the author never wrote.
 */
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
  if (consumed !== body.length || totalNs <= 0n || totalNs % 1_000_000n !== 0n) return undefined;
  return Number(totalNs / 1_000_000n);
};

/**
 * Decide whether a whole-second duration can be written as a crontab step.
 * Takes milliseconds and returns true only when the seconds, minutes, or hours
 * step divides its clock field (60 seconds, 60 minutes, or 24 hours).
 */
export const isMappableEveryDurationMs = (ms: number): boolean => {
  if (!Number.isInteger(ms) || ms < 1000) return false;
  const seconds = ms / 1000;
  if (!Number.isInteger(seconds) || seconds < 1) return false;
  if (seconds < 60) return 60 % seconds === 0;
  if (seconds % 60 !== 0) return false;
  const minutes = seconds / 60;
  if (minutes < 60) return 60 % minutes === 0;
  if (minutes % 60 !== 0) return false;
  const hours = minutes / 60;
  return Number.isInteger(hours) && hours >= 1 && hours <= 24 && 24 % hours === 0;
};

/**
 * Effect's Cron parser also accepts a leading seconds field, but the pinned
 * scheduler reads six fields as five plus a year, so a raw expression must be
 * exactly five fields for validation to mean what the scheduler does.
 */
const hasFiveCronFields = (value: string): boolean =>
  value.split(/\s+/u).filter((field) => field.length > 0).length === CRON_FIELD_COUNT;

const cronExpressionCheck = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (Object.hasOwn(CRON_MACROS, trimmed)) return undefined;
  if (EVERY_PREFIX.test(trimmed)) {
    const ms = parseEveryDurationMs(trimmed);
    if (ms === undefined) return cronExpressionMessage;
    return isMappableEveryDurationMs(ms) ? undefined : everyStepMessage;
  }
  return hasFiveCronFields(trimmed) && Result.isSuccess(Cron.parse(trimmed))
    ? undefined
    : cronExpressionMessage;
};

/**
 * Expand a named schedule (`@hourly`, `@daily`, `@weekly`, `@monthly`,
 * `@yearly`, `@annually`, `@midnight`) into its 5-field cron expression. Any
 * other input, including a raw cron expression, is returned trimmed unchanged.
 */
export const expandCronMacro = (value: string): string => {
  const trimmed = value.trim();
  return Object.hasOwn(CRON_MACROS, trimmed) ? CRON_MACROS[trimmed as keyof typeof CRON_MACROS] : trimmed;
};

export const CronExpression = Schema.String.check(
  Schema.makeFilter((value: string) => cronExpressionCheck(value)),
).annotate({
  identifier: "CronExpression",
  title: "Cron Expression",
  description:
    "Five-field cron expression, a named schedule such as @hourly, or @every with seconds or minutes that divide 60, or hours that divide 24.",
  expected: "a cron expression",
  message: cronExpressionMessage,
});
export type CronExpression = typeof CronExpression.Type;

// ============================================================================
// Job identity: the name, cadence, command, and optional container user.
// ============================================================================

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
      "When the job runs: a 5-field cron expression, a named schedule, or @every with seconds or minutes that divide 60, or hours that divide 24.",
  }),
  run: executionSiteKey(CommandSpec, "schedule-job").annotate({
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

// ============================================================================
// Service schedule list: replacing array with unique job names.
// ============================================================================

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
