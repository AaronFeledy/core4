import { Schema } from "effect";

// ==== Shared sparse HTTP scan policy fields
export const scanFields = {
  path: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isStartingWith("/")))).annotate({
    description: "URL path to probe, starting with a slash.",
  }),
  okCodes: Schema.optionalKey(
    Schema.Array(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 599 })))),
  ).annotate({
    description: "HTTP response status codes accepted as reachable.",
  }),
};
