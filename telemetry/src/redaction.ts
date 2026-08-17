/**
 * Shared telemetry redaction layer.
 *
 * Every telemetry payload passes through {@link redactTelemetryData} before it
 * is buffered or dispatched to any sink. Redaction does two things:
 *
 * 1. Allowlists fields against the canonical event inventory. For a known
 *    event only the inventory-declared fields survive, enum fields keep only
 *    inventory-allowed values, and every other field (raw command arguments,
 *    raw error messages, install directories, …) is removed. This is what
 *    constrains update telemetry to version/target/channel/platform/outcome.
 * 2. Scrubs free-string values so paths, hostnames, URLs, credentials, email
 *    addresses, UUID-like identifiers, and high-entropy tokens never reach a
 *    sink, even on an inventory-allowed field.
 *
 * The module is pure and dependency-free (only the data-only inventory) so it
 * can run in the transport's hot enqueue path without pulling in CLI or
 * service code, and so it is trivially unit-testable.
 */

import { createRedactor } from "@lando/sdk/secrets";

import { TELEMETRY_EVENTS, type TelemetryEventName, type TelemetryFieldSpec } from "./inventory.ts";

const telemetryRedactor = createRedactor("telemetry");

export const scrubTelemetryValue = (value: string): string => telemetryRedactor.redactString(value);

/** Recursively scrub every string within an arbitrary value, keeping shape. */
const scrubDeep = (value: unknown): unknown => {
  if (typeof value === "string") return scrubTelemetryValue(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key] = scrubDeep(raw);
    }
    return out;
  }
  return value;
};

/**
 * Redact a telemetry payload before it is buffered or dispatched.
 *
 * For a known event the result contains only inventory-allowed fields with
 * scrubbed values and enum values constrained to the inventory allow set. For
 * an unknown event (which the inventory gate prevents in shipped code) every
 * string is scrubbed defensively without dropping structure.
 */
export const redactTelemetryData = (
  event: string,
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const spec = TELEMETRY_EVENTS[event as TelemetryEventName];
  if (spec === undefined) {
    return scrubDeep(data) as Record<string, unknown>;
  }

  const out: Record<string, unknown> = {};
  const fields: ReadonlyArray<TelemetryFieldSpec> = spec.fields;
  for (const field of fields) {
    if (!(field.name in data)) continue;
    const raw = data[field.name];
    if (raw === undefined) continue;

    if (field.allowedValues !== undefined) {
      if (typeof raw === "string" && field.allowedValues.includes(raw)) {
        out[field.name] = raw;
      }
      continue;
    }

    out[field.name] = scrubDeep(raw);
  }
  return out;
};
