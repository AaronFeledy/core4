import { ParseResult, Schema } from "effect";

import { parseComposeByteSize } from "./compose-byte-size.ts";
import { parseComposeDuration } from "./compose-duration.ts";

const StringList = Schema.Array(Schema.String);

export const ComposeStringListField = Schema.transformOrFail(
  Schema.Union(Schema.String, StringList),
  StringList,
  {
    strict: true,
    decode: (input) => ParseResult.succeed(typeof input === "string" ? [input] : input),
    encode: (input) => ParseResult.succeed(input),
  },
);

export const ComposeCapAddField = ComposeStringListField.annotations({
  description:
    "Linux capabilities to add as a single Compose capability or capability list; canonicalized to a string list.",
});
export const ComposeCapDropField = ComposeStringListField.annotations({
  description:
    "Linux capabilities to drop as a single Compose capability or capability list; canonicalized to a string list.",
});
export const ComposeDnsField = ComposeStringListField.annotations({
  description: "Custom DNS servers as a single address or address list; canonicalized to a string list.",
});
export const ComposeDnsSearchField = ComposeStringListField.annotations({
  description: "DNS search domains as a single domain or domain list; canonicalized to a string list.",
});
export const ComposeDnsOptField = ComposeStringListField.annotations({
  description: "Resolver options as a single Compose option or option list; canonicalized to a string list.",
});
export const ComposeSecurityOptField = ComposeStringListField.annotations({
  description:
    "Container security options as a single Compose option or option list; canonicalized to a string list.",
});
export const ComposeTmpfsField = ComposeStringListField.annotations({
  description:
    "Temporary filesystem mounts as a single Compose mount string or string list; canonicalized to a string list.",
});
export type ComposeStringList = typeof ComposeStringListField.Type;

const Group = Schema.Union(Schema.String, Schema.Number);
const GroupList = Schema.Array(Group);

export const ComposeGroupAddField = Schema.transformOrFail(Schema.Union(Group, GroupList), GroupList, {
  strict: true,
  decode: (input) => ParseResult.succeed(Array.isArray(input) ? input : [input]),
  encode: (input) => ParseResult.succeed(input),
}).annotations({
  description:
    "Supplementary groups as one string or number, or as a list of either; canonicalized to a group list while preserving each value.",
});
export type ComposeGroupAdd = typeof ComposeGroupAddField.Type;

export const ComposeByteSizeField = Schema.transformOrFail(
  Schema.Union(Schema.String, Schema.Int),
  Schema.Int,
  {
    strict: true,
    decode: (input) => {
      if (typeof input === "number") return ParseResult.succeed(input);
      try {
        return ParseResult.succeed(parseComposeByteSize(input));
      } catch (error) {
        if (error instanceof ParseResult.Type) return ParseResult.fail(error);
        throw error;
      }
    },
    encode: (input) => ParseResult.succeed(input),
  },
);
export type ComposeByteSize = typeof ComposeByteSizeField.Type;

export const ComposeShmSizeField = ComposeByteSizeField.annotations({
  description:
    "Shared-memory size as integer bytes or a Compose byte-size string; canonicalized to integer bytes.",
});

export const ComposeDurationSecondsField = Schema.transformOrFail(
  Schema.Union(Schema.String, Schema.Number),
  Schema.Number,
  {
    strict: true,
    decode: (input) => {
      if (typeof input === "number") return ParseResult.succeed(input);
      try {
        return ParseResult.succeed(parseComposeDuration(input));
      } catch (error) {
        if (error instanceof ParseResult.Type) return ParseResult.fail(error);
        throw error;
      }
    },
    encode: (input) => ParseResult.succeed(input),
  },
);
export type ComposeDurationSeconds = typeof ComposeDurationSecondsField.Type;

export const ComposeStopGracePeriodField = ComposeDurationSecondsField.annotations({
  description:
    "Graceful-stop period as a Compose duration string or canonical numeric seconds; canonicalized to seconds.",
});

export const ComposeRestartField = Schema.Literal("no", "always", "on-failure", "unless-stopped");

const TimedPullPolicy = Schema.String.pipe(Schema.pattern(/^every_(?:[0-9]+[wdhms])+$/));

export const ComposePullPolicyField = Schema.Union(
  Schema.Literal("always", "never", "build", "if_not_present", "missing", "refresh", "daily", "weekly"),
  TimedPullPolicy,
);

export const ComposeBooleanOrStringField = Schema.Union(Schema.Boolean, Schema.String);
