# Telemetry Redaction and Retention Policy

This is the canonical, in-repo policy for how Lando telemetry is redacted before it leaves your machine and how long any collected data is retained. It is published before telemetry emission is enabled by default and is linked from the [telemetry event inventory](./events.md), the opt-out command output (`lando config telemetry status`), and the machine-readable inventory in [`core/src/telemetry/inventory.ts`](../../core/src/telemetry/inventory.ts).

Specification: [`spec/beta-1/prd-beta-1-06-telemetry.md`](../../spec/beta-1/prd-beta-1-06-telemetry.md).

## Redaction rules {#redaction}

Every telemetry payload passes through the shared redaction layer ([`core/src/telemetry/redaction.ts`](../../core/src/telemetry/redaction.ts)) before it is buffered or handed to any sink. Redaction runs inside the recording path, so a disabled, failing, or plugin-contributed sink can never observe a raw payload.

Redaction does two things:

1. **Field allowlisting.** For a known event, only the fields declared in the [event inventory](./events.md) survive. Enum fields keep only inventory-allowed values; any other field — install directories, raw command arguments, raw error messages, host details — is removed. This is what constrains `update-outcome` telemetry to `version`, `targetVersion`, `channel`, `platform`, and `outcome`.
2. **Value scrubbing.** Free-string values are scrubbed of sensitive content even on an allowed field. The layer rejects or removes:
   - POSIX paths, Windows drive paths, UNC paths, and `~/` home-directory aliases;
   - hostnames and fully-qualified domain names;
   - URLs, including any embedded `user:password@host` credentials;
   - email addresses;
   - UUID-like identifiers;
   - usernames, user IDs, app names, and project names carried inside the above;
   - tokens, secrets, and env-style secret assignments;
   - raw command arguments and raw error messages.

Lando does not collect per-user, per-host, per-app, or per-project stable identifiers.

## What is retained

- Categorized product events only, as listed in the [event inventory](./events.md): update outcomes and deprecated-surface use. No always-on heartbeat or liveness event is recorded.
- Only the redacted, allowlisted fields for each event. No paths, hostnames, user IDs, raw URLs, raw errors, or command arguments are retained.

## Where it is retained

- In transit and at rest, telemetry is held only in the maintainer-operated telemetry backend for the active release channel. Beta channels report to a staging endpoint until the `next` channel stabilizes; production channels report to the production endpoint.
- Nothing is persisted to a local queue across process restarts. Pending in-memory telemetry is dropped rather than delaying process shutdown.

## Who can access it

- Access to raw telemetry is limited to Lando project maintainers responsible for release and reliability triage.
- Aggregated, non-identifying summaries may be shared more broadly (for example in release notes or project reports).

## When data is deleted

- **Raw events:** retained for 30 days, then deleted.
- **Aggregated data:** derived non-identifying aggregates are retained for at most 13 months, then deleted.
- Disabling telemetry stops all future emission immediately; see below.

## How to opt out

Telemetry is fire-and-forget and never changes a command's exit code. CLI mode defaults telemetry on; library mode defaults it off unless the embedding host opts in. Disable it with any of:

- `LANDO_CONFIG__TELEMETRY__ENABLED=0` for the current process (takes precedence over config);
- the `telemetry.enabled: false` key in your global config;
- `lando config telemetry off`, which writes the same config key.

`lando config telemetry status` reports the current effective state, the source that selected it, and links back to this policy.
