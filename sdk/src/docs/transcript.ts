import { Schema } from "effect";

import { GuideId } from "./guide-frontmatter.ts";

const Iso8601Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    message: () => "Timestamp must be an ISO8601 UTC string.",
  }),
).annotations({ identifier: "TranscriptTimestamp" });

export const TranscriptRunFrame = Schema.Struct({
  kind: Schema.Literal("run"),
  command: Schema.Array(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  exit: Schema.Number.pipe(Schema.int()),
  durationMs: Schema.Number.pipe(Schema.nonNegative()),
}).annotations({
  identifier: "TranscriptRunFrame",
  title: "Transcript Run Frame",
  description: "Internal guide scenario transcript frame for an executed command.",
});
export type TranscriptRunFrame = typeof TranscriptRunFrame.Type;

export const TranscriptVerifyFrame = Schema.Struct({
  kind: Schema.Literal("verify"),
  target: Schema.Literal("event", "file", "errorTag"),
  matched: Schema.Boolean,
  expected: Schema.Unknown,
  actual: Schema.Unknown,
}).annotations({
  identifier: "TranscriptVerifyFrame",
  title: "Transcript Verify Frame",
  description: "Internal guide scenario transcript frame for a verification assertion.",
});
export type TranscriptVerifyFrame = typeof TranscriptVerifyFrame.Type;

export const TranscriptFixtureFrame = Schema.Struct({
  kind: Schema.Literal("fixture"),
  name: Schema.String,
  copiedTo: Schema.String,
}).annotations({
  identifier: "TranscriptFixtureFrame",
  title: "Transcript Fixture Frame",
  description: "Internal guide scenario transcript frame for a copied fixture.",
});
export type TranscriptFixtureFrame = typeof TranscriptFixtureFrame.Type;

export const TranscriptCleanupFrame = Schema.Struct({
  kind: Schema.Literal("cleanup"),
  command: Schema.Array(Schema.String),
  exit: Schema.Number.pipe(Schema.int()),
}).annotations({
  identifier: "TranscriptCleanupFrame",
  title: "Transcript Cleanup Frame",
  description: "Internal guide scenario transcript frame for a cleanup command.",
});
export type TranscriptCleanupFrame = typeof TranscriptCleanupFrame.Type;

export const TranscriptInspectFrame = Schema.Struct({
  kind: Schema.Literal("inspect"),
  target: Schema.Literal("file", "json", "events", "output"),
  value: Schema.Unknown,
}).annotations({
  identifier: "TranscriptInspectFrame",
  title: "Transcript Inspect Frame",
  description: "Internal guide scenario transcript frame for a captured inspection.",
});
export type TranscriptInspectFrame = typeof TranscriptInspectFrame.Type;

export const TranscriptInlineFrame = Schema.Struct({
  kind: Schema.Literal("inline"),
  lang: Schema.String,
  code: Schema.String,
}).annotations({
  identifier: "TranscriptInlineFrame",
  title: "Transcript Inline Frame",
  description: "Internal guide scenario transcript frame for a verbatim, non-executed code sample.",
});
export type TranscriptInlineFrame = typeof TranscriptInlineFrame.Type;

export const TranscriptFrame = Schema.Union(
  TranscriptRunFrame,
  TranscriptVerifyFrame,
  TranscriptFixtureFrame,
  TranscriptCleanupFrame,
  TranscriptInspectFrame,
  TranscriptInlineFrame,
).annotations({
  identifier: "TranscriptFrame",
  title: "Transcript Frame",
  description: "Internal guide scenario transcript frame.",
});
export type TranscriptFrame = typeof TranscriptFrame.Type;

export const Transcript = Schema.Struct({
  guideId: GuideId,
  scenarioId: GuideId,
  render: Schema.Boolean,
  startedAt: Iso8601Timestamp,
  finishedAt: Iso8601Timestamp,
  durationMs: Schema.Number.pipe(Schema.nonNegative()),
  exitStatus: Schema.Literal("pass", "fail"),
  frames: Schema.Array(TranscriptFrame),
}).annotations({
  identifier: "Transcript",
  title: "Guide Scenario Transcript",
  description: "Internal Alpha 2 guide scenario transcript.",
});
export type Transcript = typeof Transcript.Type;
