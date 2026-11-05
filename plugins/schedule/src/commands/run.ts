import { Effect } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { runScheduleJob } from "../run-job.ts";
import { type ScheduleRunResult, ScheduleRunResult as ScheduleRunResultSchema } from "../schemas.ts";

const render: NonNullable<ExecutableCommandSpec<ScheduleRunResult>["render"]> = Effect.fnUntraced(function* ({
  result,
}) {
  const renderer = yield* Renderer;
  if (result.stdout.length > 0) yield* renderer.output.stdout(result.stdout);
  if (result.stderr.length > 0) yield* renderer.output.stderr(result.stderr);
});

export const spec = {
  id: "schedule:run",
  namespace: "schedule",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Parent service when the job name is used more than once." },
  },
  args: {
    name: { type: "string", required: true, description: "Job name unique within the service." },
  },
  resultSchema: ScheduleRunResultSchema,
  run: Effect.fn("Schedule.run")(function* (input) {
    const name = String(input.args.name ?? "");
    const service = typeof input.flags.service === "string" ? input.flags.service : undefined;
    return yield* runScheduleJob({ name, ...(service === undefined ? {} : { service }) });
  }),
  render,
} as const satisfies ExecutableCommandSpec<ScheduleRunResult>;
