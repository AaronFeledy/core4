import { Schema } from "effect";

import { CommandSpec } from "@lando/sdk/schema";

export const ScheduleListedJob = Schema.Struct({
  service: Schema.String,
  name: Schema.String,
  every: Schema.String,
  run: CommandSpec,
  user: Schema.optionalKey(Schema.String),
  timezone: Schema.String,
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
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ScheduleRunResult = typeof ScheduleRunResult.Type;
