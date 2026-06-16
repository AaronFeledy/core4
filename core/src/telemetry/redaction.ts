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

import { TELEMETRY_EVENTS, type TelemetryEventName, type TelemetryFieldSpec } from "./inventory.ts";

const PATH_PLACEHOLDER = "[path]";
const URL_PLACEHOLDER = "[url]";
const EMAIL_PLACEHOLDER = "[email]";
const ID_PLACEHOLDER = "[id]";
const HOST_PLACEHOLDER = "[host]";
const REDACTED_PLACEHOLDER = "[redacted]";

// Any scheme://… URL (with or without embedded credentials). Removed whole so
// neither the host nor a `user:pass@` authority survives.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/giu;

// UNC share, e.g. \\server\public\team.
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._$-]+(?:\\[^\s\\'"]+)*/gu;

// Windows drive path, e.g. C:\Users\alice\project.
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s'"<>|]*/gu;

// Home-directory alias, e.g. ~/projects/app.
const HOME_ALIAS_PATTERN = /(?<![\w])~(?:\/[\w.+@-]+)+/gu;

// POSIX absolute path. The leading slash must sit at a boundary (start, space,
// quote) so a relative `scope/name` such as `@lando/old-plugin` is never
// matched as a path.
const POSIX_PATH_PATTERN = /(?<![\w@~./])\/(?:[\w.+@-]+\/)*[\w.+@-]+/gu;

// Email address (domain must contain a dot, so a bare `@scope/name` is safe).
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;

// Canonical UUID.
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

// Env-style secret assignment, e.g. DATABASE_PASSWORD=hunter2.
const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]}]+)/gu;

// `Bearer <token>` authorization values.
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[\w.~+/=-]+/giu;

// Bare hostname / FQDN left after URLs and emails are removed.
const HOSTNAME_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/giu;

// High-entropy token: a 25+ char run of token chars carrying both a letter and
// a digit. Runs last so it only catches leftover opaque secrets, not semver,
// platform keys, or surface ids (which are short and/or punctuated).
const HIGH_ENTROPY_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{25,}\b/gu;

const hasLetterAndDigit = (value: string): boolean => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);

/**
 * Scrub a single string value of every sensitive pattern. Order matters: URLs
 * and emails are removed before bare hostnames, and paths before the token
 * sweep, so each pattern operates on what the earlier ones leave behind.
 */
export const scrubTelemetryValue = (value: string): string =>
  value
    .replace(URL_PATTERN, URL_PLACEHOLDER)
    .replace(UNC_PATH_PATTERN, PATH_PLACEHOLDER)
    .replace(WINDOWS_PATH_PATTERN, PATH_PLACEHOLDER)
    .replace(HOME_ALIAS_PATTERN, PATH_PLACEHOLDER)
    .replace(POSIX_PATH_PATTERN, PATH_PLACEHOLDER)
    .replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER)
    .replace(UUID_PATTERN, ID_PLACEHOLDER)
    .replace(SECRET_ENV_PATTERN, (_, name) => `${String(name)}=${REDACTED_PLACEHOLDER}`)
    .replace(BEARER_TOKEN_PATTERN, (_, scheme) => `${String(scheme)} ${REDACTED_PLACEHOLDER}`)
    .replace(HOSTNAME_PATTERN, HOST_PLACEHOLDER)
    .replace(HIGH_ENTROPY_TOKEN_PATTERN, (match) =>
      hasLetterAndDigit(match) ? REDACTED_PLACEHOLDER : match,
    );

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
