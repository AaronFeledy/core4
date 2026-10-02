import { Effect } from "effect";
import { Schema } from "effect";

// NotifyConfig — global desktop-notification policy.

/**
 * Canonical command id shape used by `notify.commands` (e.g. `app:start`).
 * Registry membership is validated after decode at config-resolution time.
 */
export const NotifyCommandId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/)),
);
export type NotifyCommandId = typeof NotifyCommandId.Type;

/**
 * Global `notify:` config. Policy only — the renderer owns capability gating
 * and OpenTUI `triggerNotification` presentation.
 */
export const NotifyConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => true))).annotate({
    description: "Master switch for desktop notifications (global notify.enabled; default true).",
  }),
  thresholdMs: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.check(Schema.isLessThanOrEqualTo(3_600_000)),
  )
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => 15_000)))
    .annotate({
      description:
        "Minimum qualifying command duration in ms (global notify.thresholdMs; default 15000; 0 qualifies every eligible command).",
    }),
  commands: Schema.Array(NotifyCommandId)
    .pipe(Schema.check(Schema.isMaxLength(128)))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => [] as const)))
    .annotate({
      description:
        "Additional canonical command ids beyond the default notify family (global notify.commands; max 128).",
    }),
});
export type NotifyConfig = typeof NotifyConfig.Type;
