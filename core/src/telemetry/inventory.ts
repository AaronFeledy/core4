/**
 * Canonical, machine-readable telemetry event inventory.
 *
 * This module is the single source of truth for every telemetry event Lando
 * is allowed to record. The published human inventory
 * (`docs/telemetry/events.md`), the `check:telemetry-inventory` gate, the
 * doc-consistency test, and the typed data builders in `events.ts` all derive
 * from the constants here. Recording an event whose name is absent from
 * `TELEMETRY_EVENTS` fails the gate; adding an event therefore requires
 * editing this file (and the published doc) in the same change.
 *
 * Data-only and dependency-free on purpose: it is imported by `events.ts`
 * (which is off the cold-start hot path), the gate script, and tests, never
 * by the first-byte CLI path in `core/src/cli/index.ts`.
 */

/** Every telemetry field is a redaction-safe string today. */
export type TelemetryFieldType = "string";

/** A single allowed field on a telemetry event. */
export interface TelemetryFieldSpec {
  /** Field name as it appears in the recorded payload. */
  readonly name: string;
  /** Wire type of the field value. */
  readonly type: TelemetryFieldType;
  /** Closed set of allowed values when the field is an enum; omitted for free strings. */
  readonly allowedValues?: ReadonlyArray<string>;
  /** Human description of what the field carries. */
  readonly description: string;
}

/**
 * Whether an event may be recorded outside CLI mode. CLI-only events are
 * recorded exclusively by the CLI surface; library-eligible events may also
 * be recorded when an embedding host opts telemetry in.
 */
export type TelemetryEventScope = "cli-only" | "library-eligible";

/** Full metadata for one telemetry event. */
export interface TelemetryEventSpec {
  /** Canonical event name passed to `Telemetry.record`. */
  readonly event: string;
  /** Human description of when the event fires. */
  readonly description: string;
  /** Owning package. */
  readonly owner: string;
  /** Source trigger: the module and symbol that records the event. */
  readonly trigger: string;
  /** CLI-only vs library-eligible recording scope. */
  readonly scope: TelemetryEventScope;
  /** Allowed fields, in recorded order. */
  readonly fields: ReadonlyArray<TelemetryFieldSpec>;
}

/**
 * Allowed field names per event, in recorded order. The `as const` literal
 * tuples are the primitive the typed data builders in `events.ts` depend on
 * (`(typeof TELEMETRY_EVENT_FIELD_NAMES)[event][number]`); the rich
 * `TELEMETRY_EVENTS` metadata below must match this order (asserted by test).
 */
export const TELEMETRY_EVENT_FIELD_NAMES = {
  "update-outcome": ["version", "targetVersion", "channel", "platform", "outcome"],
  "deprecation-used": ["kind", "id", "since", "severity"],
} as const;

/** Canonical telemetry event name. */
export type TelemetryEventName = keyof typeof TELEMETRY_EVENT_FIELD_NAMES;

/**
 * The canonical telemetry event inventory. Beta 1 records two events and no
 * always-on runtime health event: the fire-and-forget transport drains a
 * bounded queue into sinks and emits no heartbeat of its own.
 */
export const TELEMETRY_EVENTS = {
  "update-outcome": {
    event: "update-outcome",
    description:
      "Records the categorized result of a `lando update` self-update attempt. Emitted once per update run, including failures.",
    owner: "@lando/core",
    trigger: "core/src/telemetry/events.ts:recordUpdateOutcomeTelemetry (via lando update)",
    scope: "cli-only",
    fields: [
      { name: "version", type: "string", description: "Currently running Lando version." },
      { name: "targetVersion", type: "string", description: "Version the update attempted to install." },
      {
        name: "channel",
        type: "string",
        allowedValues: ["stable", "next", "dev"],
        description: "Release channel the update resolved against.",
      },
      {
        name: "platform",
        type: "string",
        description: "Host platform key (e.g. linux-x64); not a hostname or path.",
      },
      {
        name: "outcome",
        type: "string",
        allowedValues: [
          "success",
          "signature_failure",
          "launch_probe_failure",
          "permission_failure",
          "network_failure",
        ],
        description: "Categorized update result.",
      },
    ],
  },
  "deprecation-used": {
    event: "deprecation-used",
    description:
      "Records use of a deprecated public surface. Consumed from the runtime event bus and forwarded through the Telemetry service rather than a parallel reporter.",
    owner: "@lando/core",
    trigger: "core/src/deprecation/telemetry.ts:DeprecationTelemetryLive (from DeprecationService events)",
    scope: "library-eligible",
    fields: [
      {
        name: "kind",
        type: "string",
        allowedValues: [
          "command",
          "flag",
          "arg",
          "tooling-task",
          "recipe",
          "recipe-prompt",
          "landofile-key",
          "config-key",
          "env-override",
          "schema",
          "schema-field",
          "event",
          "event-field",
          "render-event",
          "service-type",
          "service-feature",
          "route-filter",
          "provider-extension",
          "manifest-field",
          "manifest-contribution",
          "plugin",
          "export",
          "tagged-error",
        ],
        description: "Deprecated surface kind.",
      },
      {
        name: "id",
        type: "string",
        description: "Stable identifier of the deprecated surface (not user data).",
      },
      { name: "since", type: "string", description: "Version the surface was deprecated in (semver)." },
      {
        name: "severity",
        type: "string",
        allowedValues: ["info", "warn", "error"],
        description: "Declared deprecation severity.",
      },
    ],
  },
} as const satisfies Record<TelemetryEventName, TelemetryEventSpec>;

/** Set of every allowed telemetry event name, for gate lookups. */
export const TELEMETRY_EVENT_NAMES: ReadonlySet<string> = new Set(Object.keys(TELEMETRY_EVENTS));
