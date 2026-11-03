import { Effect } from "effect";

import { AppFeatureCloneError } from "@lando/sdk/errors";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { crontabLine, supercronicInstallCommand } from "./crontab.ts";
import { scheduleSidecarName } from "./jobs.ts";
import { SUPERCRONIC_PINS, SUPERCRONIC_STEP_ID, supercronicCommand } from "./supercronic.ts";

export const SCHEDULE_FEATURE_ID = "schedule.compile" as const;

const imageLacksInstallShell = (image: string | undefined): boolean => {
  if (image === undefined || image.length === 0) return false;
  const withoutDigest = image.toLowerCase().split("@")[0] ?? image.toLowerCase();
  if (withoutDigest === "scratch" || withoutDigest.startsWith("scratch:")) return true;
  if (withoutDigest.endsWith("/scratch") || withoutDigest.includes("/scratch:")) return true;
  return withoutDigest.includes("distroless");
};

export const scheduleCompileFeature: AppFeatureDefinition = {
  id: SCHEDULE_FEATURE_ID,
  priority: 200,
  activatedBy: { services: {} },
  apply: Effect.fn("ScheduleCompileFeature.apply")(function* (ctx) {
    for (const service of ctx.selected) {
      const jobs = service.normalizedConfig.schedule ?? [];
      if (jobs.length === 0) continue;
      const sidecar = scheduleSidecarName(service.serviceName);
      const image = service.normalizedConfig.image;
      if (imageLacksInstallShell(image)) {
        return yield* Effect.fail(
          new AppFeatureCloneError({
            feature: ctx.featureId,
            service: sidecar,
            from: service.serviceName,
            reason: "unsupported-image",
            ...(image === undefined ? {} : { image }),
            message: `Cannot install the scheduler into ${sidecar}: image ${image ?? "(none)"} has no shell.`,
            remediation: `Use an image that includes a shell, not distroless or scratch, or drop schedule: from ${service.serviceName}.`,
          }),
        );
      }
      const crontab = jobs.map((job) => crontabLine(job, service.normalizedConfig.user));
      ctx.addClonedService({
        from: service.serviceName,
        name: sidecar,
        command: [...supercronicCommand()],
        extraBuildSteps: [
          {
            id: SUPERCRONIC_STEP_ID,
            phase: "build",
            user: "root",
            command: ["sh", "-c", supercronicInstallCommand(crontab)],
            buildKeyInputs: { supercronic: SUPERCRONIC_PINS },
          },
        ],
        omitConfigKeys: ["schedule"],
      });
    }
  }),
};
