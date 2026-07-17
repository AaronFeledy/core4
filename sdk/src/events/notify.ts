import { Schema } from "effect";

// ====
// Desktop notification render event + invocation correlation.
// SPEC: §8.9.7 / §3.5

/**
 * Correlation ids shared across one command invocation's lifecycle triplet
 * (`cli-<id>-init` / `-run` / `-error`). The outer, notification-eligible
 * invocation has no `parentInvocationId`.
 */
export const CommandInvocationCorrelation = Schema.Struct({
  invocationId: Schema.String.annotations({
    description: "ULID unique to this command invocation (outer or nested).",
  }),
  parentInvocationId: Schema.optional(Schema.String).annotations({
    description: "ULID of the enclosing invocation; absent for the outer user/embedding-host invocation.",
  }),
});
export type CommandInvocationCorrelation = typeof CommandInvocationCorrelation.Type;

/**
 * Foreground desktop-notification request. Publishers redact title/body before
 * publish; the renderer sanitizes again before `triggerNotification`.
 */
export const NotifyDesktopEvent = Schema.TaggedStruct("notify.desktop", {
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)).annotations({
    description: "Notification title (1..256 chars after schema decode).",
  }),
  body: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))).annotations({
    description: "Optional notification body (up to 4096 chars).",
  }),
  urgency: Schema.optional(Schema.Literal("info", "success", "failure")).annotations({
    description: "Optional urgency hint for presentation consumers.",
  }),
});
export type NotifyDesktopEvent = typeof NotifyDesktopEvent.Type;
