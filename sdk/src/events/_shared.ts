import { Schema } from "effect";

export const Timestamp = Schema.DateTimeUtcFromString;

export const OutcomeFields = {
  outcome: Schema.Literals(["success", "failure"]),
  failureDetail: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
};

export const PostCallFields = {
  outcome: Schema.Literals(["success", "failure"]),
  durationMs: Schema.optional(Schema.Number),
  failureDetail: Schema.optional(Schema.String),
};
