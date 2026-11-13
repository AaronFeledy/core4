import { PlanReplanRequiredError } from "@lando/sdk/errors";
import { ServiceName, clonedServiceParent } from "@lando/sdk/schema";
import { LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

import { ScheduleJobAmbiguousError, ScheduleJobNotFoundError } from "./errors.ts";
import { findScheduleJob, jobsFromLandofile } from "./jobs.ts";

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
    const available = jobs.map((entry) => `${entry.service}.${entry.name}`);
    return yield* Effect.fail(
      new ScheduleJobNotFoundError({
        message:
          service === undefined
            ? `No scheduled job named ${name}.`
            : `No scheduled job named ${name} on service ${service}.`,
        name,
        ...(service === undefined ? {} : { service }),
        available,
        remediation:
          jobs.length === 0
            ? "Add a schedule: list on a service in the Landofile."
            : `Choose one of: ${available.join(", ")}.`,
      }),
    );
  }
  if (matches.length > 1) {
    const services = matches.map((entry) => entry.service);
    return yield* Effect.fail(
      new ScheduleJobAmbiguousError({
        message: `Job name ${name} is used on more than one service.`,
        name,
        services,
        remediation: `Pass --service with one of: ${services.join(", ")}.`,
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
  // The timer runs this job inside the sidecar for its user group, so run there
  // too: the sidecar already carries the job's user, home, cwd, and environment.
  const sidecarName = ServiceName.make(job.sidecar);
  const sidecar = planned.services[sidecarName];
  // A same-named authored service is not this job's timer: exec there would run
  // an unexpected image as the wrong user, so require the clone provenance.
  if (sidecar === undefined || clonedServiceParent(sidecar) !== job.service) {
    return yield* Effect.fail(
      new PlanReplanRequiredError({
        app: document.name ?? appRoot,
        providerId: planned.provider,
        operation: "schedule run",
        message: `Scheduled job ${job.service}.${job.name} runs in ${sidecarName}, but the applied plan has no such service cloned from ${job.service}.`,
        remediation: "Run `lando restart` to apply the schedule, then retry.",
      }),
    );
  }
  const result = yield* provider.exec(
    { app: planned.id, service: sidecarName, plan: planned },
    { command: typeof job.run === "string" ? ["sh", "-c", job.run] : job.run },
  );
  return {
    service: job.service,
    name: job.name,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
});
