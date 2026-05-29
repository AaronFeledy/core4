/**
 * Deterministic Mutagen session naming.
 *
 * This module keeps the naming rules local to the file-sync-mutagen plugin
 * so generated session names stay within Mutagen's identifier constraints
 * while remaining stable across runs.
 *
 * Rules:
 *   - Form a base string `${appId}-${serviceId}-${mountKey}`.
 *   - Lowercase ASCII; any non `[a-z0-9-]` rune folds to `-`.
 *   - Runs of `-` collapse to a single `-`; leading/trailing `-` are
 *     trimmed.
 *   - If the sanitized name fits inside `MUTAGEN_NAME_MAX`, return it
 *     verbatim. Otherwise truncate and append a 12-character SHA-256
 *     suffix of the *raw* base string so distinct long inputs that share
 *     a sanitized prefix cannot collide.
 *   - If sanitation strips all content (e.g. all-emoji input), fall back
 *     to `lando-<hash>` so the name remains a valid identifier.
 */

import { createHash } from "node:crypto";

import { FileSyncSessionRef, type FileSyncSessionSpec } from "@lando/sdk/schema";

/**
 * Upper bound on Mutagen session names. Mutagen does not publish a strict
 * ceiling, but 60 ASCII chars stays comfortably within common filesystem
 * segment limits and matches the deterministic provider-naming budget used
 * elsewhere.
 */
export const MUTAGEN_NAME_MAX = 60;

const SHORT_HASH_LEN = 12;

const INVALID_CHAR = /[^a-z0-9-]+/gu;
const COLLAPSE_DASH = /-+/gu;
const TRIM_DASH = /^-+|-+$/gu;
const VALID_NAME = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/u;

const shortHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, SHORT_HASH_LEN);

const sanitize = (raw: string): string =>
  raw.toLowerCase().replace(INVALID_CHAR, "-").replace(COLLAPSE_DASH, "-").replace(TRIM_DASH, "");

/**
 * Build a Mutagen-compatible identifier from an app/service/mount triple.
 * Exposed separately from `mutagenSessionName` so callers that already
 * know the raw segments can derive the same deterministic name without
 * constructing a full `FileSyncSessionSpec`.
 */
export const mutagenSessionNameFromParts = (parts: {
  readonly appId: string;
  readonly service: string;
  readonly mountKey: string;
}): string => {
  const raw = `${parts.appId}-${parts.service}-${parts.mountKey}`;
  const sanitized = sanitize(raw);
  if (sanitized.length === 0) return `lando-${shortHash(raw)}`;
  if (sanitized.length <= MUTAGEN_NAME_MAX) return sanitized;

  const reserve = SHORT_HASH_LEN + 1; // 12 hex chars + connecting dash
  const headLength = MUTAGEN_NAME_MAX - reserve;
  const head = sanitized.slice(0, headLength).replace(TRIM_DASH, "");
  const hashed = shortHash(raw);
  const candidate = head.length === 0 ? `lando-${hashed}` : `${head}-${hashed}`;
  return candidate.length > MUTAGEN_NAME_MAX
    ? candidate.slice(candidate.length - MUTAGEN_NAME_MAX)
    : candidate;
};

/**
 * Derive the deterministic Mutagen session name for a given
 * `FileSyncSessionSpec`. Always returns a valid kebab-case identifier
 * within the allowed length, and stays stable across runs for identical
 * inputs.
 */
export const mutagenSessionName = (spec: FileSyncSessionSpec): string =>
  mutagenSessionNameFromParts({ appId: spec.app.id, service: spec.service, mountKey: spec.mountKey });

/**
 * Convenience wrapper that brands a `mutagenSessionName` as a
 * `FileSyncSessionRef` for registration with `listSessions`.
 */
export const mutagenSessionRef = (spec: FileSyncSessionSpec): FileSyncSessionRef =>
  FileSyncSessionRef.make(mutagenSessionName(spec));

/**
 * `true` iff `name` is a valid Mutagen-compatible session name produced
 * by `mutagenSessionName`. Used by tests and downstream code that receives
 * session names from untrusted sources.
 */
export const isValidMutagenSessionName = (name: string): boolean => VALID_NAME.test(name);
