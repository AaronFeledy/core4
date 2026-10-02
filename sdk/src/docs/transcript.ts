import { Schema } from "effect";

import { GuideId } from "./guide-frontmatter.ts";

const Iso8601Timestamp = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    message: "Timestamp must be an ISO8601 UTC string.",
  })),
).annotate({ identifier: "TranscriptTimestamp" });

export const TranscriptRunFrame = Schema.Struct({
  kind: Schema.Literal("run"),
  command: Schema.Array(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  exit: Schema.Number.pipe(Schema.check(Schema.isInt())),
  durationMs: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({
  identifier: "TranscriptRunFrame",
  title: "Transcript Run Frame",
  description: "Internal guide scenario transcript frame for an executed command.",
});
export type TranscriptRunFrame = typeof TranscriptRunFrame.Type;

export const TranscriptVerifyFrame = Schema.Struct({
  kind: Schema.Literal("verify"),
  target: Schema.Literals(["event", "file", "errorTag"]),
  matched: Schema.Boolean,
  expected: Schema.Unknown,
  actual: Schema.Unknown,
}).annotate({
  identifier: "TranscriptVerifyFrame",
  title: "Transcript Verify Frame",
  description: "Internal guide scenario transcript frame for a verification assertion.",
});
export type TranscriptVerifyFrame = typeof TranscriptVerifyFrame.Type;

export const TranscriptFixtureFrame = Schema.Struct({
  kind: Schema.Literal("fixture"),
  name: Schema.String,
  copiedTo: Schema.String,
}).annotate({
  identifier: "TranscriptFixtureFrame",
  title: "Transcript Fixture Frame",
  description: "Internal guide scenario transcript frame for a copied fixture.",
});
export type TranscriptFixtureFrame = typeof TranscriptFixtureFrame.Type;

export const TranscriptCleanupFrame = Schema.Struct({
  kind: Schema.Literal("cleanup"),
  command: Schema.Array(Schema.String),
  exit: Schema.Number.pipe(Schema.check(Schema.isInt())),
}).annotate({
  identifier: "TranscriptCleanupFrame",
  title: "Transcript Cleanup Frame",
  description: "Internal guide scenario transcript frame for a cleanup command.",
});
export type TranscriptCleanupFrame = typeof TranscriptCleanupFrame.Type;

export const TranscriptInspectFrame = Schema.Struct({
  kind: Schema.Literal("inspect"),
  target: Schema.Literals(["file", "json", "events", "output"]),
  value: Schema.Unknown,
}).annotate({
  identifier: "TranscriptInspectFrame",
  title: "Transcript Inspect Frame",
  description: "Internal guide scenario transcript frame for a captured inspection.",
});
export type TranscriptInspectFrame = typeof TranscriptInspectFrame.Type;

export const TranscriptInlineFrame = Schema.Struct({
  kind: Schema.Literal("inline"),
  lang: Schema.String,
  code: Schema.String,
}).annotate({
  identifier: "TranscriptInlineFrame",
  title: "Transcript Inline Frame",
  description: "Internal guide scenario transcript frame for a verbatim, non-executed code sample.",
});
export type TranscriptInlineFrame = typeof TranscriptInlineFrame.Type;

export const TranscriptFrame = Schema.Union([TranscriptRunFrame, TranscriptVerifyFrame, TranscriptFixtureFrame, TranscriptCleanupFrame, TranscriptInspectFrame, TranscriptInlineFrame]).annotate({
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
  durationMs: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  exitStatus: Schema.Literals(["pass", "fail"]),
  frames: Schema.Array(TranscriptFrame),
}).annotate({
  identifier: "Transcript",
  title: "Guide Scenario Transcript",
  description: "Internal guide scenario transcript.",
});
export type Transcript = typeof Transcript.Type;

export const PublicTranscriptFrame = Schema.Struct({
  kind: Schema.Literals(["step", "run", "verify", "inspect", "cleanup", "inline", "tab"]),
  sourceFile: Schema.String,
  sourceLine: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  displayText: Schema.optionalKey(Schema.String),
  commandDisplay: Schema.optionalKey(Schema.String),
  resultSummary: Schema.optionalKey(Schema.String),
}).annotate({
  identifier: "PublicTranscriptFrame",
  title: "Public Transcript Frame",
  description: "Reader-visible guide scenario transcript frame attributed to its authoring MDX source.",
});
export type PublicTranscriptFrame = typeof PublicTranscriptFrame.Type;

export const PublicTranscript = Schema.Struct({
  guideId: GuideId,
  scenarioId: GuideId,
  variant: Schema.String,
  runtime: Schema.String,
  render: Schema.Boolean,
  frames: Schema.Array(PublicTranscriptFrame),
}).annotate({
  identifier: "PublicTranscript",
  title: "Public Guide Scenario Transcript",
  description: "Public reader-scenario transcript emitted by scenario generation for docs output.",
});
export type PublicTranscript = typeof PublicTranscript.Type;
