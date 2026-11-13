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

export const scheduleCompileFeature: AppFeatureDefinition = {
  id: SCHEDULE_FEATURE_ID,
  priority: 200,
  activatedBy: { services: {} },
  apply: Effect.fn("ScheduleCompileFeature.apply")(function* (ctx) {
    for (const service of ctx.selected) {
      const jobs = service.normalizedConfig.schedule ?? [];
      if (jobs.length === 0) continue;
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
              command: ["sh", "-c", crontabInstallCommand(crontab)],
              buildKeyInputs: { crontab },
            },
          ],
          omitConfigKeys: ["schedule"],
        });
      }
    }
  }),
};
