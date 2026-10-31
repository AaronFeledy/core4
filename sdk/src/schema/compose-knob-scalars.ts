import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

import { parseComposeByteSize } from "./compose-byte-size.ts";
import { parseComposeDuration } from "./compose-duration.ts";

const StringList = Schema.Array(Schema.String);

export const ComposeStringListField = Schema.Union([Schema.String, StringList]).pipe(
  Schema.decodeTo(
    StringList,
    SchemaTransformation.transformEffect({
      decode: (input) => Effect.succeed(typeof input === "string" ? [input] : input),
      encode: (input) => Effect.succeed(input),
    }),
  ),
);

export const ComposeCapAddField = ComposeStringListField.annotate({
  description:
    "Linux capabilities to add as a single Compose capability or capability list; canonicalized to a string list.",
});
export const ComposeCapDropField = ComposeStringListField.annotate({
  description:
    "Linux capabilities to drop as a single Compose capability or capability list; canonicalized to a string list.",
});
export const ComposeDnsField = ComposeStringListField.annotate({
  description: "Custom DNS servers as a single address or address list; canonicalized to a string list.",
});
export const ComposeDnsSearchField = ComposeStringListField.annotate({
  description: "DNS search domains as a single domain or domain list; canonicalized to a string list.",
});
export const ComposeDnsOptField = ComposeStringListField.annotate({
  description: "Resolver options as a single Compose option or option list; canonicalized to a string list.",
});
export const ComposeSecurityOptField = ComposeStringListField.annotate({
  description:
    "Container security options as a single Compose option or option list; canonicalized to a string list.",
});
export const ComposeTmpfsField = ComposeStringListField.annotate({
  description:
    "Temporary filesystem mounts as a single Compose mount string or string list; canonicalized to a string list.",
});
export type ComposeStringList = typeof ComposeStringListField.Type;

const Group = Schema.Union([Schema.String, Schema.Number]);
const GroupList = Schema.Array(Group);

export const ComposeGroupAddField = Schema.Union([Group, GroupList])
  .pipe(
    Schema.decodeTo(
      GroupList,
      SchemaTransformation.transformEffect({
        decode: (input) =>
          Effect.succeed(typeof input === "string" || typeof input === "number" ? [input] : input),
        encode: (input) => Effect.succeed(input),
      }),
    ),
  )
  .annotate({
    description:
      "Supplementary groups as one string or number, or as a list of either; canonicalized to a group list while preserving each value.",
  });
export type ComposeGroupAdd = typeof ComposeGroupAddField.Type;

export const ComposeByteSizeField = Schema.Union([Schema.String, Schema.Int]).pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transformEffect({
      decode: (input) => {
        if (typeof input === "number") return Effect.succeed(input);
        try {
          return Effect.succeed(parseComposeByteSize(input));
        } catch (error) {
          if (error instanceof SchemaIssue.InvalidValue) return Effect.fail(error);
          throw error;
        }
      },
      encode: (input) => Effect.succeed(input),
    }),
  ),
);
export type ComposeByteSize = typeof ComposeByteSizeField.Type;

export const ComposeShmSizeField = ComposeByteSizeField.annotate({
  description:
    "Shared-memory size as integer bytes or a Compose byte-size string; canonicalized to integer bytes.",
});

export const ComposeDurationSecondsField = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformEffect({
      decode: (input) => {
        if (typeof input === "number") return Effect.succeed(input);
        try {
          return Effect.succeed(parseComposeDuration(input));
        } catch (error) {
          if (error instanceof SchemaIssue.InvalidValue) return Effect.fail(error);
          throw error;
        }
      },
      encode: (input) => Effect.succeed(input),
    }),
  ),
);
export type ComposeDurationSeconds = typeof ComposeDurationSecondsField.Type;

export const ComposeStopGracePeriodField = ComposeDurationSecondsField.annotate({
  description:
    "Graceful-stop period as a Compose duration string or canonical numeric seconds; canonicalized to seconds.",
});

export const ComposeRestartField = Schema.Literals(["no", "always", "on-failure", "unless-stopped"]);

const TIMED_PULL_POLICY_PATTERN = /^every_(?:[0-9]+[wdhms])+$/;
const TimedPullPolicy = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(TIMED_PULL_POLICY_PATTERN, {
      expected: "every_<interval> such as every_12h",
      toJsonSchema: () => ({ pattern: TIMED_PULL_POLICY_PATTERN.source }),
    }),
  ),
);

export const ComposePullPolicyField = Schema.Union([
  Schema.Literals(["always", "never", "build", "if_not_present", "missing", "refresh", "daily", "weekly"]),
  TimedPullPolicy,
]).annotate({
  message:
    "Expected always, never, build, if_not_present, missing, refresh, daily, weekly, or every_<interval> such as every_12h",
});

export const ComposeBooleanOrStringField = Schema.Union([Schema.Boolean, Schema.String]);

// JSON Schema has no regex flags; the end assertion also rejects trailing line breaks.
const INIT_SPELLING_PATTERN =
  /^(?:[Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee]|[Oo][Nn]|[Oo][Ff][Ff]|[Yy][Ee][Ss]|[Nn][Oo]|[01])(?![\s\S])/;

export const ComposeInitField = Schema.Union([
  Schema.Boolean,
  Schema.String.check(
    Schema.isPattern(INIT_SPELLING_PATTERN, {
      expected: "true, false, on, off, yes, no, 1, or 0 (ASCII case-insensitive)",
      toJsonSchema: () => ({ pattern: INIT_SPELLING_PATTERN.source }),
    }),
  ),
]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (input) =>
        typeof input === "boolean" ? input : ["true", "on", "1", "yes"].includes(input.toLowerCase()),
      encode: (input) => input,
    }),
  ),
);
