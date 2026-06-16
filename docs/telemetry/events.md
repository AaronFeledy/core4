# Telemetry Event Inventory

This is the canonical, in-repo inventory of every telemetry event Lando records. It lists each event's allowed fields, field types, allowed values, owning package, source trigger, and recording scope (CLI-only vs library-eligible).

The machine-readable source of truth lives in [`core/src/telemetry/inventory.ts`](../../core/src/telemetry/inventory.ts). The `check:telemetry-inventory` gate fails when code records an event that is not declared there, and a consistency test fails when this document drifts from it. Adding a telemetry event therefore requires editing the inventory module **and** this document in the same change.

Specification: [`spec/beta-1/prd-beta-1-06-telemetry.md`](../../spec/beta-1/prd-beta-1-06-telemetry.md).

Related reference schemas: [telemetry config](../reference/schemas/telemetry-config.mdx) and the [`deprecation-used` event](../reference/schemas/deprecation-used-event.mdx).

## Defaults, opt-out, and retention {#defaults-and-retention}

Telemetry is fire-and-forget: recording never blocks command completion, never changes the exit code, and is dropped rather than delaying shutdown. CLI mode defaults telemetry on; library mode defaults it off unless the embedding host opts in. Disable it with `LANDO_CONFIG__TELEMETRY__ENABLED=0`, the `telemetry.enabled` config key, or the documented opt-out command.

Every payload is redacted before it is buffered or dispatched: fields are allowlisted to the inventory below and free-string values are scrubbed of paths, hostnames, URLs, credentials, email addresses, UUID-like identifiers, and tokens. The full redaction rules and the retention policy (what is retained, where, who can access it, and when raw and aggregated data are deleted) live in the canonical [telemetry redaction and retention policy](./retention.md).

## Always-on runtime health events

None. The transport drains a bounded in-memory queue into registered sinks and emits no always-on runtime health event (no heartbeat or liveness ping) of its own. The only events recorded are the ones listed below.

## Events

### `update-outcome`

- **Owner:** `@lando/core`
- **Trigger:** `core/src/telemetry/events.ts:recordUpdateOutcomeTelemetry (via lando update)`
- **Scope:** CLI-only

Records the categorized result of a `lando update` self-update attempt. Emitted once per update run, including failures.

| Field | Type | Allowed values | Description |
| --- | --- | --- | --- |
| `version` | string | (any) | Currently running Lando version. |
| `targetVersion` | string | (any) | Version the update attempted to install. |
| `channel` | string | `stable`, `next`, `dev` | Release channel the update resolved against. |
| `platform` | string | (any) | Host platform key (e.g. linux-x64); not a hostname or path. |
| `outcome` | string | `success`, `signature_failure`, `launch_probe_failure`, `permission_failure`, `network_failure` | Categorized update result. |

### `deprecation-used`

- **Owner:** `@lando/core`
- **Trigger:** `core/src/deprecation/telemetry.ts:DeprecationTelemetryLive (from DeprecationService events)`
- **Scope:** Library-eligible

Records use of a deprecated public surface. Consumed from the runtime event bus and forwarded through the Telemetry service rather than a parallel reporter.

| Field | Type | Allowed values | Description |
| --- | --- | --- | --- |
| `kind` | string | `command`, `flag`, `arg`, `tooling-task`, `recipe`, `recipe-prompt`, `landofile-key`, `config-key`, `env-override`, `schema`, `schema-field`, `event`, `event-field`, `render-event`, `service-type`, `service-feature`, `route-filter`, `provider-extension`, `manifest-field`, `manifest-contribution`, `plugin`, `export`, `tagged-error` | Deprecated surface kind. |
| `id` | string | (any) | Stable identifier of the deprecated surface (not user data). |
| `since` | string | (any) | Version the surface was deprecated in (semver). |
| `severity` | string | `info`, `warn`, `error` | Declared deprecation severity. |
