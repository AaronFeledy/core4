import { Cron, DateTime, Duration, Result } from "effect";

import { expandCronMacro, parseEveryDurationMs } from "@lando/sdk/schema";

export const nextRunAt = (every: string, now: DateTime.Utc, timezone: string): DateTime.Utc | undefined => {
  const everyMs = parseEveryDurationMs(every);
  if (everyMs !== undefined) return DateTime.addDuration(now, Duration.millis(everyMs));
  const parsed = Cron.parse(expandCronMacro(every), timezone);
  if (Result.isFailure(parsed)) return undefined;
  return DateTime.makeUnsafe(Cron.next(parsed.success, now).toISOString());
};

export const formatNextRun = (value: DateTime.Utc | undefined): string | undefined =>
  value === undefined ? undefined : DateTime.formatIso(value);
