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
  return DateTime.makeUnsafe(Cron.next(parsed.success, now).toISOString());
};

export const formatNextRun = (value: DateTime.Utc | undefined): string | undefined =>
  value === undefined ? undefined : DateTime.formatIso(value);
