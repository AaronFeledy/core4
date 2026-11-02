import { Effect } from "effect";
import { Schema } from "effect";

// ====
// Subscriber manifest / selector contracts for plugin event handlers.

/**
 * Bounded subscriber selector: exact event name, or the named terminal family
 * cli-command-terminal (matches canonical command run/error events at dispatch).
 * No regex, wildcard, or partial match.
 */
export const SubscriberSelector = Schema.Union([
  Schema.Struct({
    event: Schema.String.annotate({
      description: "Exact built-in or generated lifecycle event name.",
    }),
  }),
  Schema.Struct({
    family: Schema.Literal("cli-command-terminal").annotate({
      description:
        "Terminal family: cli-<canonical-id>-run and cli-<canonical-id>-error, matched at dispatch.",
    }),
  }),
]);
export type SubscriberSelector = typeof SubscriberSelector.Type;

/**
 * Closed set of global-config keys a subscriber may request via configKey.
 * Publishes only notify (projects decoded NotifyConfig).
 */
export const PublishedGlobalConfigKey = Schema.Literal("notify");
export type PublishedGlobalConfigKey = typeof PublishedGlobalConfigKey.Type;

/**
 * Plugin subscribers entry. Shape/syntax validated at manifest read;
 * static selector membership is validated at registration; deferred app targets
 * are checked when an authoritative app-command catalog is supplied.
 * Plugin priority is restricted to the default band (100..999); omitted → 500.
 */
export const SubscriberManifestEntry = Schema.Struct({
  id: Schema.String.annotate({
    description: "Subscriber id unique within the contributing plugin.",
  }),
  selectors: Schema.Array(SubscriberSelector)
    .pipe(Schema.check(Schema.isMinLength(1)))
    .annotate({
      description: "One or more exact-event or cli-command-terminal family selectors.",
    }),
  module: Schema.String.annotate({
    description: "Relative module path whose default export is a SubscriberFactory.",
  }),
  priority: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(100)),
    Schema.check(Schema.isLessThanOrEqualTo(999)),
  )
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 500)))
    .annotate({
      description: "Priority in the plugin default band 100..999 (default 500).",
    }),
  abortOnError: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "When true, subscriber errors at post-* events abort the step (default false).",
  }),
  configKey: Schema.optionalKey(PublishedGlobalConfigKey).annotate({
    description: "Optional published global-config key projected as the factory's second argument.",
  }),
});
export type SubscriberManifestEntry = typeof SubscriberManifestEntry.Type;
