/**
 * Canonical redaction primitive — the single source of truth for masking
 * secret/PII material out of log, diagnostic, telemetry, and transcript output.
 *
 * `createRedactor(profile, options)` composes two layers:
 *
 * 1. The **value layer** ({@link createSecretRedactor}): every known secret
 *    value is matched literally, and each run of overlapping occurrences is
 *    masked as one union. Applying the value layer before the pattern layer
 *    guarantees a registered secret never survives by being split across a
 *    pattern boundary.
 * 2. The **pattern layer**: a fixed catalog of pattern classes, selected by
 *    profile, that normalizes secrets and PII to deterministic sentinels and
 *    placeholders. An assignment or signed-query value that is exactly one
 *    complete environment-variable reference (`${IDENT}`, `${IDENT?}`,
 *    `$${IDENT}`, `$${IDENT?}`, `$IDENT`, bare or double-quoted, with equal
 *    backslash runs when escaped) is left intact at a verified terminator so
 *    config examples and remediation stay readable; a suffix, a single-quoted
 *    or escaped-dollar form, unequal backslash runs, and malformed or truncated
 *    bodies still mask. Registered values win in the value layer below.
 *
 *    The secret classes recognize `name=value` (spaced or not), an unquoted key
 *    with a colon and a quoted value anywhere in a line, a quoted-key member in
 *    JSON/Python/escaped-JSON spelling, and a block-mapping key at line start
 *    (whose bare value is the rest of the line). A quoted value may span
 *    newlines; an escaped opener closes at the next quote. `redactString` treats
 *    its input as complete text and masks an unterminated quoted value to the
 *    end, while `redactPrefix` leaves it as written for a stream holder.
 *
 * Three profiles are published:
 *
 * - `secrets`: assignment/userinfo/bearer/signed-query masking + object
 *   key-name masking, emitting the `[redacted]` sentinel.
 * - `telemetry`: the `secrets` classes plus normalizing classes that collapse
 *   paths/urls/hosts/emails/ids to `[path]`/`[url]`/`[host]`/`[email]`/`[id]`.
 * - `transcript`: deterministic placeholders (`<HOME>`/`<TMP>`/`<PORT>`/
 *   `<CONTAINER_ID>`/`<DIGEST>`/`<PROVIDER_ID>`/`<USER>`/`<HOST>`) for
 *   reproducible documentation output.
 *
 * The module is **pure and dependency-free**: no `@lando/core`, no Effect
 * runtime, no Node/Bun IO. Environment roots for the `transcript` profile are
 * supplied by the caller via `options.env`; the primitive never reads
 * `node:os`. This keeps it usable on the telemetry hot-enqueue path and in the
 * docs build without constructing a runtime.
 */

import { retainWithinBytes } from "./bounded-redaction.ts";
import { redactedInspection } from "./inspection.ts";
import { REDACTED, createSecretRedactor } from "./redactor.ts";
import { SECRET_FIELD_PATTERN, isSecretFieldName } from "./secret-names.ts";
import { redactSecrets, redactSecretsBounded } from "./secret-scanner.ts";
import {
  TRANSCRIPT_PATTERN_CLASSES,
  type TranscriptRedactionEnv,
  redactTranscriptString,
} from "./transcript-redaction.ts";
import { URL_USERINFO_PATTERN } from "./url-userinfo.ts";
import { redactValueWith } from "./value-redaction.ts";

export type { TranscriptRedactionEnv } from "./transcript-redaction.ts";

/** The redaction profiles published by {@link createRedactor}. */
export const REDACTION_PROFILES = ["secrets", "telemetry", "transcript"] as const;

/** A redaction profile selecting which pattern classes apply. */
export type RedactionProfile = (typeof REDACTION_PROFILES)[number];

/** Options accepted by {@link createRedactor}. */
export interface CreateRedactorOptions {
  /** Known secret values masked by the value layer before any pattern pass. */
  readonly values?: Iterable<string>;
  readonly wholeTokenValues?: Iterable<string>;
  /** Explicit secret values; unsafe exact matches suppress the whole affected detail. */
  readonly authoritativeValues?: Iterable<string>;
  /** Environment roots for the `transcript` profile's literal masking. */
  readonly env?: TranscriptRedactionEnv;
}

/** A composed redactor returned by {@link createRedactor}. */
export interface Redactor {
  /**
   * Redact a complete string: the value layer, then the profile patterns, then
   * the value of an unterminated quoted construct to the end of the input.
   */
  readonly redactString: (text: string) => string;
  /**
   * The same layers without closing an unterminated construct, for a caller
   * holding a stream until its closer arrives.
   */
  readonly redactPrefix: (text: string) => string;
  readonly redactStringBounded?: (text: string, maxBytes: number) => string | undefined;
  /**
   * Redact an arbitrary value, preserving array/object/`Error` shape, masking
   * `secretKeyedField` keys, and never throwing on cyclic or exotic input.
   */
  readonly redactValue: (value: unknown) => unknown;
}

/** A single pattern class: a matcher and its replacement. */
export interface PatternClass {
  readonly pattern: RegExp;
  readonly replace: string | ((substring: string, ...groups: string[]) => string);
}

const PATH = "[path]";
const URL = "[url]";
const EMAIL = "[email]";
const ID = "[id]";
const HOST = "[host]";

const TELEMETRY_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/giu;
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._$-]+(?:\\[^\s\\'"]+)*/gu;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s'"<>|]*/gu;
const HOME_ALIAS_PATTERN = /(?<![\w])~(?:\/[\w.+@-]+)+/gu;
const POSIX_PATH_PATTERN = /(?<![\w@~./])\/(?:[\w.+@-]+\/)*[\w.+@-]+/gu;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const HOSTNAME_PATTERN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/giu;
const HIGH_ENTROPY_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{25,}\b/gu;

const hasLetterAndDigit = (value: string): boolean => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value);

const redactTelemetryString = (text: string): string =>
  text
    .replace(TELEMETRY_URL_PATTERN, URL)
    .replace(UNC_PATH_PATTERN, PATH)
    .replace(WINDOWS_PATH_PATTERN, PATH)
    .replace(HOME_ALIAS_PATTERN, PATH)
    .replace(POSIX_PATH_PATTERN, PATH)
    .replace(EMAIL_PATTERN, EMAIL)
    .replace(UUID_PATTERN, ID)
    .replace(HOSTNAME_PATTERN, HOST)
    .replace(HIGH_ENTROPY_TOKEN_PATTERN, (match) => (hasLetterAndDigit(match) ? REDACTED : match));

/**
 * The canonical pattern-class catalog. Data-only (matcher + replacement) so a
 * downstream consumer can reference a single source of truth instead of copying
 * regexes. The `secretKeyedField` matcher tests an object key name; the rest
 * apply to string values.
 */
export const PATTERN_CLASSES: Readonly<Record<string, PatternClass>> = Object.freeze({
  urlUserinfo: { pattern: URL_USERINFO_PATTERN, replace: `${REDACTED}@` },
  secretKeyedField: { pattern: SECRET_FIELD_PATTERN, replace: REDACTED },
  url: { pattern: TELEMETRY_URL_PATTERN, replace: URL },
  posixPath: { pattern: POSIX_PATH_PATTERN, replace: PATH },
  windowsPath: { pattern: WINDOWS_PATH_PATTERN, replace: PATH },
  email: { pattern: EMAIL_PATTERN, replace: EMAIL },
  uuid: { pattern: UUID_PATTERN, replace: ID },
  hostname: { pattern: HOSTNAME_PATTERN, replace: HOST },
  uncPath: { pattern: UNC_PATH_PATTERN, replace: PATH },
  homeAlias: { pattern: HOME_ALIAS_PATTERN, replace: PATH },
  highEntropyToken: {
    pattern: HIGH_ENTROPY_TOKEN_PATTERN,
    replace: (match: string) => (hasLetterAndDigit(match) ? REDACTED : match),
  },
  ...TRANSCRIPT_PATTERN_CLASSES,
});

/**
 * A registered value that overlaps the sentinel (`"[redacted]"` registered with
 * its quotes) can match text the pattern layer just produced, so for such a
 * value set the composed layers repeat until the output stops changing and fail
 * closed after a bounded number of passes. Other value sets reach a fixed point
 * in one pass, so they skip the check.
 */
const MAX_CONVERGENCE_PASSES = 8;

const convergeLayers =
  (redact: (text: string) => string) =>
  (text: string): string => {
    let output = redact(text);
    for (let pass = 1; pass < MAX_CONVERGENCE_PASSES; pass += 1) {
      const next = redact(output);
      if (next === output) return output;
      output = next;
    }
    return REDACTED;
  };

const convergeBoundedLayers =
  (redact: (text: string, maxBytes: number) => string | undefined) =>
  (text: string, maxBytes: number): string | undefined => {
    let output = redact(text, maxBytes);
    for (let pass = 1; pass < MAX_CONVERGENCE_PASSES; pass += 1) {
      if (output === undefined) return undefined;
      const next = redact(output, maxBytes);
      if (next === output) return output;
      output = next;
    }
    return retainWithinBytes(REDACTED, maxBytes);
  };

/**
 * Build a {@link Redactor} for the given profile. The value layer (known secret
 * values) is always applied before the profile's pattern layer.
 */
export const createRedactor = (
  profile: RedactionProfile,
  options: CreateRedactorOptions = {},
): Redactor & typeof redactedInspection => {
  const valueLayer = createSecretRedactor(
    options.values ?? [],
    options.authoritativeValues,
    options.wholeTokenValues,
  );
  const env = options.env ?? {};

  // Telemetry and transcript normalization runs after the secrets stage closes an
  // open value, so their placeholders never see an unproven tail.
  const normalize = (secrets: string): string => {
    switch (profile) {
      case "telemetry":
        return redactTelemetryString(secrets);
      case "transcript":
        return redactTranscriptString(secrets, env, (value) => value);
      case "secrets":
        return secrets;
    }
  };

  const converge = valueLayer.crossesSentinel ? convergeLayers : (redact: (text: string) => string) => redact;
  const redactPrefix = converge((text) => normalize(redactSecrets(valueLayer.redact(text), false)));
  const redactString = converge((text) => normalize(redactSecrets(valueLayer.redact(text), true)));

  const boundedValueLayer = valueLayer.redactBounded;
  const boundedOnce =
    profile === "secrets" && boundedValueLayer !== undefined
      ? (text: string, maxBytes: number): string | undefined => {
          const valueRedacted = boundedValueLayer(text, maxBytes);
          return valueRedacted === undefined ? undefined : redactSecretsBounded(valueRedacted, maxBytes);
        }
      : undefined;
  const redactStringBounded =
    boundedOnce === undefined || !valueLayer.crossesSentinel
      ? boundedOnce
      : convergeBoundedLayers(boundedOnce);

  return {
    ...redactedInspection,
    redactString,
    redactPrefix,
    ...(redactStringBounded === undefined ? {} : { redactStringBounded }),
    redactValue: (value) => redactValueWith(redactString, isSecretFieldName, value),
  };
};
