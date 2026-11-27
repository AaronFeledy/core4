import { CommandSpec } from "@lando/sdk/schema";
import { Schema } from "effect";

export const ScheduleListedJob = Schema.Struct({
  service: Schema.String,
  name: Schema.String,
  every: Schema.String,
  run: CommandSpec,
  user: Schema.optionalKey(Schema.String),
  timezone: Schema.String,
  sidecar: Schema.String,
  nextRun: Schema.optionalKey(Schema.String),
});
export type ScheduleListedJob = typeof ScheduleListedJob.Type;

export const ScheduleListResult = Schema.Struct({
  jobs: Schema.Array(ScheduleListedJob),
});
export type ScheduleListResult = typeof ScheduleListResult.Type;

export const ScheduleRunResult = Schema.Struct({
  service: Schema.String,
  name: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.optionalKey(Schema.String).annotate({
    description: "The job's captured standard output; omitted when it streamed live.",
  }),
  stderr: Schema.optionalKey(Schema.String).annotate({
    description: "The job's captured standard error; omitted when it streamed live.",
  }),
});
export type ScheduleRunResult = typeof ScheduleRunResult.Type;
