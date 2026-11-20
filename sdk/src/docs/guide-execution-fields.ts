import { Schema } from "effect";

export const GuideTimeout = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
);

export const GuideSkip = Schema.Struct({
  reason: Schema.String.annotate({ description: "Why this test is skipped." }),
  until: Schema.optionalKey(
    Schema.String.annotate({ description: "Optional note about when to revisit the skip." }),
  ),
});
