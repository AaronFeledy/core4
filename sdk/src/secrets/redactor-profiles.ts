/**
 * Canonical redaction primitive — the single source of truth for masking
 * secret/PII material out of log, diagnostic, telemetry, and transcript output.
 *
 * `createRedactor(profile, options)` composes two layers:
 *
 * 1. The **value layer** ({@link createSecretRedactor}): every known secret
 *    value, matched literally and longest-first, is masked first. Applying the
 *    value layer before the pattern layer guarantees a registered secret never
 *    survives by being split across a pattern boundary.
 * 2. The **pattern layer**: a fixed catalog of pattern classes, selected by
 *    profile, that normalizes secrets and PII to deterministic sentinels and
 *    placeholders.
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

import { replacePatternsBounded } from "./bounded-redaction.ts";
import { REDACTED, createSecretRedactor } from "./redactor.ts";
import {
  TRANSCRIPT_PATTERN_CLASSES,
  type TranscriptRedactionEnv,
  redactTranscriptString,
} from "./transcript-redaction.ts";
import { redactValueWith } from "./value-redaction.ts";

export type { TranscriptRedactionEnv } from "./transcript-redaction.ts";

/** The redaction profiles published by {@link createRedactor}. */
export const REDACTION_PROFILES = ["secrets", "telemetry", "transcript"] as const;

/** A redaction profile selecting which pattern classes apply. */
export type RedactionProfile = (typeof REDACTION_PROFILES)[number];

/**
 * Environment roots for the `transcript` profile. The primitive performs
 * literal masking only for the values actually supplied; it never reads
 * `node:os`, so a caller (the core `RedactionService` / docs build) supplies
 * resolved defaults.
 */

/** Options accepted by {@link createRedactor}. */
export interface CreateRedactorOptions {
  /** Known secret values masked by the value layer before any pattern pass. */
  readonly values?: Iterable<string>;
  /** Environment roots for the `transcript` profile's literal masking. */
  readonly env?: TranscriptRedactionEnv;
}

/** A composed redactor returned by {@link createRedactor}. */
export interface Redactor {
  /** Redact a single string with the value layer then the profile patterns. */
  readonly redactString: (text: string) => string;
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

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ASSIGNMENT_PATTERN =
  /(?<![?&])\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Za-z0-9_]*)=([^\s,;"'\]}]+)/giu;

const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gu;

const ENCODED_URL_USERINFO_PATTERN =
  /([a-zA-Z][a-zA-Z0-9+.-]*%3A%2F%2F)[^&\s"'\]}{]*?%3A[^&\s"'\]}{]*?%40/giu;

const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[\w.~+/=-]+/giu;

const SIGNED_QUERY_PARAM_PATTERN =
  /([?&](?:[\w-]*[-_])?(?:access[_-]?token|token|secret|password|passwd|credential|signature|sig|api[_-]?key|apikey)=)([^&\s"'\]}]+)/giu;

const redactSecretsString = (text: string): string =>
  text
    .replace(SECRET_ASSIGNMENT_PATTERN, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(URL_USERINFO_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(ENCODED_URL_USERINFO_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}%40`)
    .replace(BEARER_TOKEN_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SIGNED_QUERY_PARAM_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);

const SECRETS_REPLACEMENTS = [
  { pattern: SECRET_ASSIGNMENT_PATTERN, replace: (_m: string, name: string) => `${name}=${REDACTED}` },
  { pattern: URL_USERINFO_PATTERN, replace: (_m: string, scheme: string) => `${scheme}${REDACTED}@` },
  {
    pattern: ENCODED_URL_USERINFO_PATTERN,
    replace: (_m: string, scheme: string) => `${scheme}${REDACTED}%40`,
  },
  { pattern: BEARER_TOKEN_PATTERN, replace: (_m: string, scheme: string) => `${scheme} ${REDACTED}` },
  { pattern: SIGNED_QUERY_PARAM_PATTERN, replace: (_m: string, prefix: string) => `${prefix}${REDACTED}` },
] as const;

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
  secretAssignment: {
    pattern: SECRET_ASSIGNMENT_PATTERN,
    replace: (_m, name: string) => `${name}=${REDACTED}`,
  },
  urlUserinfo: { pattern: URL_USERINFO_PATTERN, replace: (_m, scheme: string) => `${scheme}${REDACTED}@` },
  bearerToken: { pattern: BEARER_TOKEN_PATTERN, replace: (_m, scheme: string) => `${scheme} ${REDACTED}` },
  signedQueryParam: {
    pattern: SIGNED_QUERY_PARAM_PATTERN,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  secretKeyedField: { pattern: SECRET_KEY_PATTERN, replace: REDACTED },
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
 * Build a {@link Redactor} for the given profile. The value layer (known secret
 * values) is always applied before the profile's pattern layer.
 */
export const createRedactor = (profile: RedactionProfile, options: CreateRedactorOptions = {}): Redactor => {
  const valueLayer = createSecretRedactor(options.values ?? []);
  const env = options.env ?? {};

  const patternString =
    profile === "telemetry"
      ? (text: string) => redactTelemetryString(redactSecretsString(text))
      : profile === "transcript"
        ? (text: string) => redactTranscriptString(text, env, redactSecretsString)
        : redactSecretsString;

  const redactString = (text: string): string => patternString(valueLayer.redact(text));
  const boundedValueLayer = valueLayer.redactBounded;
  const redactStringBounded =
    profile === "secrets" && boundedValueLayer !== undefined
      ? (text: string, maxBytes: number): string | undefined => {
          const valueRedacted = boundedValueLayer(text, maxBytes);
          return valueRedacted === undefined
            ? undefined
            : replacePatternsBounded(valueRedacted, SECRETS_REPLACEMENTS, maxBytes);
        }
      : undefined;

  return {
    redactString,
    ...(redactStringBounded === undefined ? {} : { redactStringBounded }),
    redactValue: (value) => redactValueWith(redactString, (key) => SECRET_KEY_PATTERN.test(key), value),
  };
};
