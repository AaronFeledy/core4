/**
 * Lifecycle event payload schemas.
 *
 * Event scopes: Lando, App, Provider, Tooling, CLI. The `EventService`
 * publishes payloads in priority bands, with a standard cold-start sequence.
 *
 * Each event payload is a `Schema.TaggedStruct` so the discriminator
 * `_tag` is part of the schema. The full discriminated union over every
 * known event payload is exported as `LandoEvent`.
 *
 * Status: stub. Only a representative subset of events is declared here.
 * The complete catalog is built out as the runtime lands.
 */
import { Schema } from "effect";

import { AppPlan, AppRef, ServiceName } from "../schema/index.ts";

export type { AppRef };

const Timestamp = Schema.DateTimeUtc;

// =============================================================================
// Lando-scope events
// =============================================================================

export const PreBootstrapEvent = Schema.TaggedStruct("pre-bootstrap", {
  level: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
  timestamp: Timestamp,
});
export type PreBootstrapEvent = typeof PreBootstrapEvent.Type;

export const PostBootstrapEvent = Schema.TaggedStruct("post-bootstrap", {
  level: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
  timestamp: Timestamp,
});
export type PostBootstrapEvent = typeof PostBootstrapEvent.Type;

export const ReadyEvent = Schema.TaggedStruct("ready", {
  timestamp: Timestamp,
});
export type ReadyEvent = typeof ReadyEvent.Type;

export const BeforeExitEvent = Schema.TaggedStruct("before-exit", {
  exitCode: Schema.Number,
  timestamp: Timestamp,
});
export type BeforeExitEvent = typeof BeforeExitEvent.Type;

// =============================================================================
// App-scope events
// =============================================================================

export const PreInitEvent = Schema.TaggedStruct("pre-init", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreInitEvent = typeof PreInitEvent.Type;

export const PostInitEvent = Schema.TaggedStruct("post-init", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostInitEvent = typeof PostInitEvent.Type;

export const PreStartEvent = Schema.TaggedStruct("pre-start", {
  app: AppRef,
  plan: AppPlan,
  triggeredBy: Schema.String,
  timestamp: Timestamp,
});
export type PreStartEvent = typeof PreStartEvent.Type;

export const PostStartEvent = Schema.TaggedStruct("post-start", {
  app: AppRef,
  plan: AppPlan,
  timestamp: Timestamp,
});
export type PostStartEvent = typeof PostStartEvent.Type;

export const PreStopEvent = Schema.TaggedStruct("pre-stop", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreStopEvent = typeof PreStopEvent.Type;

export const PostStopEvent = Schema.TaggedStruct("post-stop", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostStopEvent = typeof PostStopEvent.Type;

export const PreRebuildEvent = Schema.TaggedStruct("pre-rebuild", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreRebuildEvent = typeof PreRebuildEvent.Type;

export const PostRebuildEvent = Schema.TaggedStruct("post-rebuild", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostRebuildEvent = typeof PostRebuildEvent.Type;

export const PreDestroyEvent = Schema.TaggedStruct("pre-destroy", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PreDestroyEvent = typeof PreDestroyEvent.Type;

export const PostDestroyEvent = Schema.TaggedStruct("post-destroy", {
  app: AppRef,
  timestamp: Timestamp,
});
export type PostDestroyEvent = typeof PostDestroyEvent.Type;

// =============================================================================
// Provider-scope events
// =============================================================================

export const PreProviderApplyEvent = Schema.TaggedStruct("pre-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PreProviderApplyEvent = typeof PreProviderApplyEvent.Type;

export const PostProviderApplyEvent = Schema.TaggedStruct("post-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PostProviderApplyEvent = typeof PostProviderApplyEvent.Type;

export const PreProviderExecEvent = Schema.TaggedStruct("pre-provider-exec", {
  app: AppRef,
  service: ServiceName,
  timestamp: Timestamp,
});
export type PreProviderExecEvent = typeof PreProviderExecEvent.Type;

export const PostProviderExecEvent = Schema.TaggedStruct("post-provider-exec", {
  app: AppRef,
  service: ServiceName,
  exitCode: Schema.Number,
  timestamp: Timestamp,
});
export type PostProviderExecEvent = typeof PostProviderExecEvent.Type;

// =============================================================================
// CLI-scope events
// =============================================================================

export const CliCommandInitEvent = Schema.TaggedStruct("cli-command-init", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandInitEvent = typeof CliCommandInitEvent.Type;

export const CliCommandRunEvent = Schema.TaggedStruct("cli-command-run", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandRunEvent = typeof CliCommandRunEvent.Type;

export const CliCommandErrorEvent = Schema.TaggedStruct("cli-command-error", {
  commandId: Schema.String,
  message: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandErrorEvent = typeof CliCommandErrorEvent.Type;

// =============================================================================
// Discriminated union
// =============================================================================

/**
 * `LandoEvent` is the discriminated union over every known event payload.
 * `EventService.publish` is type-narrowed against this union, so publishing
 * an unknown event is a compile error.
 *
 * Note: this union is intentionally open-ended via the `_tag` discriminator;
 * tooling events (`pre-<tool>`, `post-<tool>`) are user-derived names that
 * extend the union at runtime via Schema.TaggedStruct templating elsewhere.
 */
export const LandoEvent = Schema.Union(
  PreBootstrapEvent,
  PostBootstrapEvent,
  ReadyEvent,
  BeforeExitEvent,
  PreInitEvent,
  PostInitEvent,
  PreStartEvent,
  PostStartEvent,
  PreStopEvent,
  PostStopEvent,
  PreRebuildEvent,
  PostRebuildEvent,
  PreDestroyEvent,
  PostDestroyEvent,
  PreProviderApplyEvent,
  PostProviderApplyEvent,
  PreProviderExecEvent,
  PostProviderExecEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  CliCommandErrorEvent,
);
export type LandoEvent = typeof LandoEvent.Type;

// =============================================================================
// Subscriber priority bands
// =============================================================================

export const SubscriberPriority = {
  critical: { min: 0, max: 9 },
  early: { min: 10, max: 99 },
  default: { min: 100, max: 999 },
  late: { min: 1000, max: 9999 },
  final: { min: 10000, max: Number.MAX_SAFE_INTEGER },
} as const;

export type SubscriberPriorityBand = keyof typeof SubscriberPriority;
