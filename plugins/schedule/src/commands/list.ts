import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { LandofileService, Renderer } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import { jobsFromLandofile } from "../jobs.ts";
import { formatNextRun, nextRunAt } from "../next-run.ts";
import { type ScheduleListResult, ScheduleListResult as ScheduleListResultSchema } from "../schemas.ts";

const render: NonNullable<ExecutableCommandSpec<ScheduleListResult>["render"]> = Effect.fnUntraced(
  function* ({ result }) {
    const renderer = yield* Renderer;
    if (result.jobs.length === 0) {
      yield* renderer.output.stdout("No scheduled jobs.\n");
      return;
    }
    const lines = result.jobs.map((job) => {
      const next = job.nextRun === undefined ? "unknown" : job.nextRun;
      const user = job.user === undefined ? "" : ` user=${job.user}`;
      return `${job.service}.${job.name}  ${job.every}  next=${next}  tz=${job.timezone}${user}`;
    });
    yield* renderer.output.stdout(`${lines.join("\n")}\n`);
  },
);

export const spec = {
  id: "schedule:list",
  namespace: "schedule",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Limit the list to one service." },
  },
  resultSchema: ScheduleListResultSchema,
  run: Effect.fn("Schedule.list")(function* (input) {
    const landofiles = yield* LandofileService;
    const landofile = yield* landofiles.discover;
    const service = typeof input.flags.service === "string" ? input.flags.service : undefined;
    const now = yield* DateTime.now;
    const jobs = jobsFromLandofile(landofile.document)
      .filter((job) => service === undefined || job.service === service)
      .map((job) => {
        const nextRun = formatNextRun(nextRunAt(job.every, now, job.timezone));
        return {
          service: job.service,
          name: job.name,
          every: job.every,
          run: job.run,
          ...(job.user === undefined ? {} : { user: job.user }),
          timezone: job.timezone,
          ...(nextRun === undefined ? {} : { nextRun }),
        };
      });
    return { jobs };
  }),
  render,
} as const satisfies ExecutableCommandSpec<ScheduleListResult>;
