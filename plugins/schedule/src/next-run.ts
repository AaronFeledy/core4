import { expandCronMacro } from "@lando/sdk/schema";
import { Cron, DateTime, Result } from "effect";

import { everyToSupercronicSchedule } from "./crontab.ts";

/**
 * Effect's Cron accepts 5 fields or 6 with leading seconds; the supercronic
 * seconds form adds a trailing year field the job never reaches.
 */
const effectCronFields = (schedule: string): string => {
  const fields = schedule.trim().split(/\s+/u);
  return fields.length === 7 ? fields.slice(0, 6).join(" ") : schedule;
};

export const nextRunAt = (every: string, now: DateTime.Utc, timezone: string): DateTime.Utc | undefined => {
  const schedule = everyToSupercronicSchedule(every);
  if (schedule === undefined) return undefined;
  const parsed = Cron.parse(expandCronMacro(effectCronFields(schedule)), timezone);
  if (Result.isFailure(parsed)) return undefined;
  // Cron.next throws for a calendar it can never satisfy (for example 31
  // February), which the schema and the scheduler both accept. One job with no
  // possible next run must not fail the whole listing.
  const next = Result.try({ try: () => Cron.next(parsed.success, now), catch: () => undefined });
  if (Result.isFailure(next)) return undefined;
  return DateTime.makeUnsafe(next.success.toISOString());
};

export const formatNextRun = (value: DateTime.Utc | undefined): string | undefined =>
  value === undefined ? undefined : DateTime.formatIso(value);
