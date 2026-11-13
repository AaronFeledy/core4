import type { EnvironmentValue } from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";
import { Effect } from "effect";

import { crontabInstallCommand, crontabLine, supercronicInstallCommand } from "./crontab.ts";
import { scheduleSidecarGroups } from "./jobs.ts";
import {
  SUPERCRONIC_CRONTAB_STEP_ID,
  SUPERCRONIC_PINS,
  SUPERCRONIC_STEP_ID,
  supercronicCommand,
} from "./supercronic.ts";

export const SCHEDULE_FEATURE_ID = "schedule.compile" as const;

const IANA_ZONE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;

/**
 * The one leading `:` is a POSIX TZ form that keeps UTC and zone names alike;
 * only a real IANA zone names a `/usr/share/zoneinfo` file to check.
 */
const scheduleTimezone = (value: EnvironmentValue | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const zone = value.startsWith(":") ? value.slice(1) : value;
  return !zone.startsWith("Etc/") && IANA_ZONE.test(zone) ? zone : undefined;
};

export const scheduleCompileFeature: AppFeatureDefinition = {
  id: SCHEDULE_FEATURE_ID,
  priority: 200,
  activatedBy: { services: {} },
  apply: Effect.fn("ScheduleCompileFeature.apply")(function* (ctx) {
    for (const service of ctx.selected) {
      const jobs = service.normalizedConfig.schedule ?? [];
      if (jobs.length === 0) continue;
      const timezone = scheduleTimezone(service.normalizedConfig.environment?.TZ);
      for (const group of scheduleSidecarGroups(service.serviceName, jobs)) {
        const crontab = group.jobs.map((job) => crontabLine(job));
        ctx.addClonedService({
          from: service.serviceName,
          name: group.name,
          ...(group.user === undefined ? {} : { user: group.user }),
          command: [...supercronicCommand()],
          extraBuildSteps: [
            {
              id: SUPERCRONIC_STEP_ID,
              phase: "build",
              user: "root",
              command: ["sh", "-c", supercronicInstallCommand()],
              buildKeyInputs: { supercronic: SUPERCRONIC_PINS },
            },
            {
              id: SUPERCRONIC_CRONTAB_STEP_ID,
              phase: "build",
              user: "root",
              command: [
                "sh",
                "-c",
                crontabInstallCommand(
                  crontab,
                  timezone === undefined ? undefined : { service: service.serviceName, zone: timezone },
                ),
              ],
              buildKeyInputs: { crontab, ...(timezone === undefined ? {} : { timezone }) },
            },
          ],
          omitConfigKeys: ["schedule"],
        });
      }
    }
  }),
};
