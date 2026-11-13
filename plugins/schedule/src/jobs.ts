import type { CommandSpec, EnvironmentValue, LandofileShape } from "@lando/sdk/schema";

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

export interface ScheduleJobIdentity {
  readonly user?: string;
}

export interface ScheduleSidecarGroup<Job extends ScheduleJobIdentity = ScheduleJobIdentity> {
  readonly name: string;
  readonly user?: string;
  readonly jobs: ReadonlyArray<Job>;
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

const scheduleUserSlug = (user: string): string =>
  user
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const scheduleGroupSuffix = (user: string | undefined): string =>
  user === undefined ? "default" : scheduleUserSlug(user);

export const scheduleSidecarGroupName = (
  service: string,
  groupIndex: number,
  user: string | undefined,
): string =>
  groupIndex === 0
    ? scheduleSidecarName(service)
    : `${scheduleSidecarName(service)}-${scheduleGroupSuffix(user)}`;

/**
 * Group a service's jobs by the exact `user:` string each job runs as. Jobs
 * without `user:` form one inherit group that keeps the parent service identity.
 * The first-seen group gets the plain sidecar name; later groups are suffixed
 * by their user slug, or `default` for the inherit group.
 */
export const scheduleSidecarGroups = <Job extends ScheduleJobIdentity>(
  service: string,
  jobs: ReadonlyArray<Job>,
): ReadonlyArray<ScheduleSidecarGroup<Job>> => {
  const grouped = new Map<string | undefined, Job[]>();
  for (const job of jobs) {
    const entries = grouped.get(job.user);
    if (entries === undefined) grouped.set(job.user, [job]);
    else entries.push(job);
  }
  return [...grouped.entries()].map(([user, groupedJobs], index) => ({
    name: scheduleSidecarGroupName(service, index, user),
    ...(user === undefined ? {} : { user }),
    jobs: groupedJobs,
  }));
};
