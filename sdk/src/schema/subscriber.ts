import { Schema } from "effect";

// ====
// Subscriber manifest / selector contracts for plugin event handlers.

/**
 * Bounded subscriber selector: exact event name, or the one closed family
 * cli-command-terminal (expands to every canonical command's run/error pair).
 * No regex, wildcard, or partial match.
 */
export const SubscriberSelector = Schema.Union(
  Schema.Struct({
    event: Schema.String.annotations({
      description: "Exact built-in or generated lifecycle event name.",
    }),
  }),
  Schema.Struct({
    family: Schema.Literal("cli-command-terminal").annotations({
      description:
        "Precomputed family: cli-<canonical-id>-run and cli-<canonical-id>-error for every command.",
    }),
  }),
);
export type SubscriberSelector = typeof SubscriberSelector.Type;

/**
 * Closed set of global-config keys a subscriber may request via configKey.
 * Beta 1 publishes only notify (projects decoded NotifyConfig).
 */
export const PublishedGlobalConfigKey = Schema.Literal("notify");
export type PublishedGlobalConfigKey = typeof PublishedGlobalConfigKey.Type;

/**
 * Plugin subscribers entry. Shape/syntax validated at manifest read;
 * selector semantics (event membership / family expansion) run after registration.
 * Plugin priority is restricted to the default band (100..999); omitted → 500.
 */
export const SubscriberManifestEntry = Schema.Struct({
  id: Schema.String.annotations({
    description: "Subscriber id unique within the contributing plugin.",
  }),
  selectors: Schema.Array(SubscriberSelector).pipe(Schema.minItems(1)).annotations({
    description: "One or more exact-event or cli-command-terminal family selectors.",
  }),
  module: Schema.String.annotations({
    description: "Relative module path whose default export is a SubscriberFactory.",
  }),
  priority: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(100), Schema.lessThanOrEqualTo(999)),
    { default: () => 500 },
  ).annotations({
    description: "Priority in the plugin default band 100..999 (default 500).",
  }),
  abortOnError: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "When true, subscriber errors at post-* events abort the step (default false).",
  }),
  configKey: Schema.optional(PublishedGlobalConfigKey).annotations({
    description: "Optional published global-config key projected as the factory's second argument.",
  }),
});
export type SubscriberManifestEntry = typeof SubscriberManifestEntry.Type;
