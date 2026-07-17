import { Schema } from "effect";

// NotifyConfig — global desktop-notification policy.

/**
 * Canonical command id shape used by `notify.commands` (e.g. `app:start`).
 * Registry membership is validated after decode at config-resolution time.
 */
export const NotifyCommandId = Schema.String.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/),
);
export type NotifyCommandId = typeof NotifyCommandId.Type;

/**
 * Global `notify:` config. Policy only — the renderer owns capability gating
 * and OpenTUI `triggerNotification` presentation.
 */
export const NotifyConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }).annotations({
    description: "Master switch for desktop notifications (global notify.enabled; default true).",
  }),
  thresholdMs: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(3_600_000)),
    { default: () => 15_000 },
  ).annotations({
    description:
      "Minimum qualifying command duration in ms (global notify.thresholdMs; default 15000; 0 qualifies every eligible command).",
  }),
  commands: Schema.optionalWith(Schema.Array(NotifyCommandId).pipe(Schema.maxItems(128)), {
    default: () => [] as const,
  }).annotations({
    description:
      "Additional canonical command ids beyond the default notify family (global notify.commands; max 128).",
  }),
});
export type NotifyConfig = typeof NotifyConfig.Type;
