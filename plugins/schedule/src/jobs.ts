import {
  type CommandSpec,
  type EnvironmentValue,
  type LandofileShape,
  type ScheduleJob,
  ServiceName,
} from "@lando/sdk/schema";

export const SCHEDULE_SIDECAR_SUFFIX = "-schedule" as const;

export const scheduleSidecarName = (service: string): string => `${service}${SCHEDULE_SIDECAR_SUFFIX}`;

export interface ResolvedScheduleJob {
  readonly service: string;
  readonly name: string;
  readonly every: string;
  readonly run: CommandSpec;
  readonly user?: string;
  readonly timezone: string;
}

const timezoneOf = (environment: Readonly<Record<string, EnvironmentValue>> | undefined): string => {
  const value = environment?.TZ;
  return typeof value === "string" && value.length > 0 ? value : "UTC";
};

export const jobsFromLandofile = (landofile: LandofileShape): ReadonlyArray<ResolvedScheduleJob> => {
  const jobs: ResolvedScheduleJob[] = [];
  for (const [service, config] of Object.entries(landofile.services ?? {})) {
    const timezone = timezoneOf(config.environment);
    for (const job of config.schedule ?? []) {
      jobs.push({
        service,
        name: job.name,
        every: job.every,
        run: job.run,
        ...(job.user === undefined ? {} : { user: job.user }),
        timezone,
      });
    }
  }
  return jobs;
};

export const findScheduleJob = (
  jobs: ReadonlyArray<ResolvedScheduleJob>,
  name: string,
  service?: string,
): ReadonlyArray<ResolvedScheduleJob> =>
  jobs.filter((job) => job.name === name && (service === undefined || job.service === service));

export const parentUserOf = (landofile: LandofileShape, service: string): string | undefined =>
  landofile.services?.[ServiceName.make(service)]?.user;

export type { ScheduleJob };
