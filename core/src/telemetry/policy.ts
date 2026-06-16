/**
 * Telemetry policy links.
 *
 * Single source of truth for the in-repo locations of the telemetry retention
 * policy and the canonical event inventory. The opt-out command output, the
 * published event inventory, and the inventory module all reference these so a
 * user who reads any one surface can find the policy from the others.
 *
 * Kept data-only and dependency-free so the opt-out command path can import it
 * cheaply without pulling in the telemetry transport.
 */

/** Repo-relative path to the telemetry retention policy document. */
export const TELEMETRY_RETENTION_POLICY_DOC = "docs/telemetry/retention.md" as const;

/** Repo-relative path to the canonical telemetry event inventory document. */
export const TELEMETRY_EVENT_INVENTORY_DOC = "docs/telemetry/events.md" as const;

/** Policy links surfaced by the telemetry opt-out command output. */
export const TELEMETRY_POLICY_LINKS = {
  retention: TELEMETRY_RETENTION_POLICY_DOC,
  inventory: TELEMETRY_EVENT_INVENTORY_DOC,
} as const;
