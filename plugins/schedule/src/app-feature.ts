import type { AppFeatureDefinition } from "@lando/sdk/services";
import { Effect } from "effect";

import { crontabInstallCommand, everyToSupercronicSchedule, supercronicInstallCommand } from "./crontab.ts";
import { scheduleSidecarGroups, scheduleTimezone } from "./jobs.ts";
import {
  SUPERCRONIC_BIN,
  SUPERCRONIC_CRONTAB,
  SUPERCRONIC_CRONTAB_STEP_ID,
  SUPERCRONIC_JOBS_DIRECTORY,
  SUPERCRONIC_PINS,
  SUPERCRONIC_STEP_ID,
  supercronicCommand,
} from "./supercronic.ts";

export const SCHEDULE_FEATURE_ID = "schedule.compile" as const;

export const scheduleCompileFeature: AppFeatureDefinition = {
  id: SCHEDULE_FEATURE_ID,
  priority: 200,
  activatedBy: { services: {} },
  apply: Effect.fn("ScheduleCompileFeature.apply")(function* (ctx) {
    for (const service of ctx.selected) {
      const jobs = service.normalizedConfig.schedule ?? [];
      if (jobs.length === 0) continue;
      // Listing, the crontab, and the scheduler must agree on one zone, so the
      // step always pins the sidecar's zone instead of inheriting the image's.
      const timezone = scheduleTimezone(service.normalizedConfig.environment);
      for (const group of scheduleSidecarGroups(service.serviceName, jobs)) {
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
                  group.jobs,
                  {
                    crontab: SUPERCRONIC_CRONTAB,
                    jobsDirectory: SUPERCRONIC_JOBS_DIRECTORY,
                    scheduler: SUPERCRONIC_BIN,
                  },
                  { service: service.serviceName, zone: timezone },
                ),
              ],
              buildKeyInputs: {
                jobs: group.jobs.map((job) => ({
                  name: job.name,
                  schedule: everyToSupercronicSchedule(job.every) ?? job.every,
                  run: job.run,
                })),
                timezone,
              },
            },
          ],
          omitConfigKeys: ["schedule"],
        });
      }
    }
  }),
};
