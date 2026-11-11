import { PlanReplanRequiredError } from "@lando/sdk/errors";
import type { CommandSpec as SchemaCommandSpec } from "@lando/sdk/schema";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

import { commandToShell } from "./crontab.ts";
import { ScheduleJobAmbiguousError, ScheduleJobNotFoundError, ScheduleRunFailedError } from "./errors.ts";
import { type ResolvedScheduleJob, findScheduleJob, jobsFromLandofile, parentUserOf } from "./jobs.ts";

const jobLabels = (jobs: ReadonlyArray<ResolvedScheduleJob>): ReadonlyArray<string> =>
  jobs.map((job) => `${job.service}.${job.name}`);

const argvFor = (run: SchemaCommandSpec): ReadonlyArray<string> =>
  typeof run === "string" ? ["sh", "-c", run] : run;

const resolveScheduleJob = Effect.fn("Schedule.resolveJob")(function* (
  name: string,
  service: string | undefined,
) {
  const landofiles = yield* LandofileService;
  const landofile = yield* landofiles.discover;
  const jobs = jobsFromLandofile(landofile.document);
  const matches = findScheduleJob(jobs, name, service);
  const job = matches[0];
  if (job === undefined) {
    return yield* Effect.fail(
      new ScheduleJobNotFoundError({
        message:
          service === undefined
            ? `No scheduled job named ${name}.`
            : `No scheduled job named ${name} on service ${service}.`,
        name,
        ...(service === undefined ? {} : { service }),
        available: jobLabels(jobs),
        remediation:
          jobs.length === 0
            ? "Add a schedule: list on a service in the Landofile."
            : `Choose one of: ${jobLabels(jobs).join(", ")}.`,
      }),
    );
  }
  if (matches.length > 1) {
    return yield* Effect.fail(
      new ScheduleJobAmbiguousError({
        message: `Job name ${name} is used on more than one service.`,
        name,
        services: matches.map((entry) => entry.service),
        remediation: `Pass --service with one of: ${matches.map((entry) => entry.service).join(", ")}.`,
      }),
    );
  }
  return { document: landofile.document, appRoot: landofile.context.appRoot, job };
});

export const runScheduleJob = Effect.fn("Schedule.runJob")(function* (input: {
  readonly name: string;
  readonly service?: string;
}) {
  const { document, appRoot, job } = yield* resolveScheduleJob(input.name, input.service);
  const registry = yield* RuntimeProviderRegistry;
  const planned = yield* registry.resolveAppliedPlan(appRoot);
  if (planned === undefined) {
    return yield* Effect.fail(
      new PlanReplanRequiredError({
        app: document.name ?? appRoot,
        providerId: "unobserved",
        operation: "schedule run",
        message: "No applied plan is available for this app.",
        remediation: "Run `lando start` so the parent service is running, then retry.",
      }),
    );
  }
  const provider = yield* registry.select(planned);
  const user = job.user ?? parentUserOf(document, job.service);
  const result = yield* provider.exec(
    {
      app: AppId.make(planned.id),
      service: ServiceName.make(job.service),
      plan: planned,
      ...(user === undefined ? {} : { user }),
    },
    { command: [...argvFor(job.run)] },
  );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new ScheduleRunFailedError({
        message: `Scheduled job ${job.service}.${job.name} exited ${result.exitCode}.`,
        name: job.name,
        service: job.service,
        exitCode: result.exitCode,
        ...(result.stderr.length === 0 ? {} : { stderr: result.stderr }),
        remediation: `Fix ${commandToShell(job.run)} so it succeeds when run in ${job.service}.`,
      }),
    );
  }
  return {
    service: job.service,
    name: job.name,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
});
