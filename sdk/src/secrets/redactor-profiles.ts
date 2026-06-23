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

import { REDACTED, createSecretRedactor } from "./redactor.ts";

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
export interface TranscriptRedactionEnv {
  readonly home?: string;
  readonly tmp?: string;
  readonly user?: string;
  readonly host?: string;
  readonly extraRoots?: readonly string[];
}

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

// --- Deterministic placeholders ---

const PATH = "[path]";
const URL = "[url]";
const EMAIL = "[email]";
const ID = "[id]";
const HOST = "[host]";

const HOME_PH = "<HOME>";
const TMP_PH = "<TMP>";
const USER_PH = "<USER>";
const HOST_PH = "<HOST>";
const PORT_PH = "<PORT>";
const CONTAINER_ID_PH = "<CONTAINER_ID>";
const PROVIDER_ID_PH = "<PROVIDER_ID>";
const DIGEST_PH = "<DIGEST>";

// --- secrets-profile pattern classes ---

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ASSIGNMENT_PATTERN =
  /(?<![?&])\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Za-z0-9_]*)=([^\s,;"'\]}]+)/giu;

const URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gu;

const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[\w.~+/=-]+/giu;

const SIGNED_QUERY_PARAM_PATTERN =
  /([?&](?:[\w-]*[-_])?(?:access[_-]?token|token|secret|password|passwd|credential|signature|sig|api[_-]?key|apikey)=)([^&\s"'\]}]+)/giu;

const redactSecretsString = (text: string): string =>
  text
    .replace(SECRET_ASSIGNMENT_PATTERN, (_m, name: string) => `${name}=${REDACTED}`)
    .replace(URL_USERINFO_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(BEARER_TOKEN_PATTERN, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(SIGNED_QUERY_PARAM_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);

// --- telemetry-profile pattern classes ---

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

// --- transcript-profile pattern classes ---

const WELL_KNOWN_PORTS = new Set([80, 443, 3000, 3306, 5432, 8080, 8443, 9000, 9229]);

const REPO_RELATIVE_FIXTURE_PATH_PATTERN =
  /(^|[\s"'`(=])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])*fixtures[\\/][^\s"'`)]+)/giu;
const SHORT_SECRET_EQUALS_FLAG_PATTERN =
  /(^|[\s"'`(])(-[tk])\s*=\s*(?:\\"[^"]*\\"|\\'[^']*\\'|\\`[^`]*\\`|"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`&?=)]+)/giu;
const SHORT_SECRET_SPACE_FLAG_PATTERN =
  /(^|[\s"'`(])(-[tk])\s+(?:\\"[^"]*\\"|\\'[^']*\\'|\\`[^`]*\\`|"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`&?=)]+)/giu;
const GENERIC_KEY_EQUALS_SECRET_PATTERN =
  /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|credential|bearer|apikey|api[_-]?key)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`&?]+)/giu;
const GENERIC_KEY_SPACE_SECRET_PATTERN =
  /\b(token|secret|password|passwd|credential|bearer|apikey|api[_-]?key)\s+(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`&?=]+)/giu;
const TOKEN_SECRET_LITERAL_PATTERN = /\btoken\s+secret\b/gi;
const TRANSCRIPT_QUERY_SECRET_PATTERN =
  /([?&](?:[\w-]*[-_])?(?:access[_-]?token|token|secret|password|passwd|credential|signature|sig|api[_-]?key|apikey)=)([^&\s"']+)/giu;
const DOUBLE_MARKER_PATTERN = /\[\s*redacted\s*\]\s*\]/giu;

const GENERIC_PATH_PATTERNS: readonly RegExp[] = [
  /\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /\/root(?:\/[^\s"'`]*)?/gi,
  /\/var\/folders\/[^/]+\/T(?:\/[^\s"'`]*)?/gi,
  /\/tmp\/(?:lando-)?[^/\s"'`]+(?:\/[^\s"'`]*)?/gi,
  /[A-Za-z]:\\(?:Users|AppData\\Local\\Temp)[^"\s'`]*/gi,
  /%USERPROFILE%[^"\s'`]*/gi,
  /%TEMP%[^"\s'`]*/gi,
];

const TRANSCRIPT_ROOT_PATTERN =
  /\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?|\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?|\/root(?:\/[^\s"'`]*)?|\/var\/folders\/[^/]+\/T(?:\/[^\s"'`]*)?|\/tmp\/(?:lando-)?[^/\s"'`]+(?:\/[^\s"'`]*)?|[A-Za-z]:\\(?:Users|AppData\\Local\\Temp)[^"\s'`]*|%USERPROFILE%[^"\s'`]*|%TEMP%[^"\s'`]*/giu;
const PORT_PATTERN = /:(\d{2,5})\b/gu;
const CONTAINER_ID_PATTERN = /\b(?:[0-9a-f]{12}|[0-9a-f]{16,63})\b/giu;
const DIGEST_PATTERN = /\bsha256:[0-9a-f]{64}\b/giu;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactTranscriptPaths = (text: string, env: TranscriptRedactionEnv): string => {
  let out = text.replace(REPO_RELATIVE_FIXTURE_PATH_PATTERN, (_m, prefix: string) => `${prefix}${HOME_PH}`);

  for (const re of GENERIC_PATH_PATTERNS) {
    out = out.replace(re, (m) => (/tmp|Temp/i.test(m) ? TMP_PH : HOME_PH));
  }

  const roots: Array<{ value: string; placeholder: string }> = [];
  if (env.home) roots.push({ value: env.home, placeholder: HOME_PH });
  if (env.tmp) roots.push({ value: env.tmp, placeholder: TMP_PH });
  if (env.extraRoots?.length) {
    for (const r of env.extraRoots) roots.push({ value: r, placeholder: HOME_PH });
  }

  const sorted = [...roots].sort((a, b) => b.value.length - a.value.length);
  for (const { value, placeholder } of sorted) {
    if (!value) continue;
    out = out.replace(new RegExp(escapeRegExp(value), "gi"), placeholder);
  }

  return out;
};

const redactTranscriptPorts = (text: string): string =>
  text.replace(/:(\d{2,5})\b/g, (_m, p: string) => {
    const port = Number(p);
    if (!Number.isFinite(port)) return _m;
    if (WELL_KNOWN_PORTS.has(port)) return _m;
    if (port >= 1024) return `:${PORT_PH}`;
    return _m;
  });

const redactTranscriptContainerIds = (text: string): string =>
  text
    .replace(/\b([0-9a-f]{12})\b/gi, CONTAINER_ID_PH)
    .replace(/\b([0-9a-f]{16,63})\b/gi, CONTAINER_ID_PH)
    .replace(/\bsha256:([0-9a-f]{64})\b/gi, `sha256:${DIGEST_PH}`);

const redactTranscriptProviderIds = (text: string): string =>
  text.replace(/\b([A-Za-z0-9_-]+[_-](?:web|app|db|svc)[_-][A-Za-z0-9_-]+)\b/gi, PROVIDER_ID_PH);

const redactTranscriptLiterals = (text: string, env: TranscriptRedactionEnv): string => {
  let out = text;
  if (env.user) out = out.replace(new RegExp(`\\b${escapeRegExp(env.user)}\\b`, "gi"), USER_PH);
  if (env.host) out = out.replace(new RegExp(`\\b${escapeRegExp(env.host)}\\b`, "gi"), HOST_PH);
  return out;
};

const redactTranscriptBareSecrets = (text: string): string =>
  text
    .replace(
      SHORT_SECRET_EQUALS_FLAG_PATTERN,
      (_m, prefix: string, key: string) => `${prefix}${key}=${REDACTED}`,
    )
    .replace(
      SHORT_SECRET_SPACE_FLAG_PATTERN,
      (_m, prefix: string, key: string) => `${prefix}${key} ${REDACTED}`,
    )
    .replace(GENERIC_KEY_EQUALS_SECRET_PATTERN, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(GENERIC_KEY_SPACE_SECRET_PATTERN, (_m, key: string) => `${key} ${REDACTED}`)
    .replace(TOKEN_SECRET_LITERAL_PATTERN, `token ${REDACTED}`);

const redactTranscriptQuerySecrets = (text: string): string =>
  text.replace(TRANSCRIPT_QUERY_SECRET_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`);

const redactTranscriptString = (text: string, env: TranscriptRedactionEnv): string => {
  if (!text) return text;
  let out = text;
  out = redactTranscriptPaths(out, env);
  out = redactTranscriptPorts(out);
  out = redactTranscriptContainerIds(out);
  out = redactTranscriptProviderIds(out);
  out = redactTranscriptLiterals(out, env);
  out = redactTranscriptBareSecrets(out);
  out = redactTranscriptQuerySecrets(out);
  out = redactSecretsString(out);
  out = out.replace(DOUBLE_MARKER_PATTERN, REDACTED);
  return out;
};

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
  port: {
    pattern: PORT_PATTERN,
    replace: (match: string, portText: string) => {
      const port = Number(portText);
      if (!Number.isFinite(port)) return match;
      if (WELL_KNOWN_PORTS.has(port)) return match;
      return port >= 1024 ? `:${PORT_PH}` : match;
    },
  },
  containerId: { pattern: CONTAINER_ID_PATTERN, replace: CONTAINER_ID_PH },
  digest: { pattern: DIGEST_PATTERN, replace: `sha256:${DIGEST_PH}` },
  providerId: {
    pattern: /\b([A-Za-z0-9_-]+[_-](?:web|app|db|svc)[_-][A-Za-z0-9_-]+)\b/gi,
    replace: PROVIDER_ID_PH,
  },
  root: { pattern: TRANSCRIPT_ROOT_PATTERN, replace: HOME_PH },
});

// --- deep value walker ---

const redactValueWith = (
  profileString: (text: string) => string,
  value: unknown,
  stack: WeakSet<object>,
  memo: WeakMap<object, unknown>,
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return profileString(value);
  if (typeof value !== "object") return value;

  const memoHit = memo.get(value);
  if (memoHit !== undefined) return memoHit;
  if (stack.has(value)) return "[circular]";

  stack.add(value);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redactValueWith(profileString, item, stack, memo));
  } else if (value instanceof Error) {
    result = { name: value.name, message: profileString(value.message) };
  } else {
    let keys: string[];
    try {
      keys = Object.keys(value as Record<string, unknown>);
    } catch {
      result = REDACTED;
      stack.delete(value);
      memo.set(value, result);
      return result;
    }

    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      let raw: unknown;
      try {
        raw = (value as Record<string, unknown>)[key];
      } catch {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValueWith(profileString, raw, stack, memo);
    }
    result = out;
  }

  stack.delete(value);
  memo.set(value, result);
  return result;
};

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
        ? (text: string) => redactTranscriptString(text, env)
        : redactSecretsString;

  const redactString = (text: string): string => patternString(valueLayer.redact(text));

  return {
    redactString,
    redactValue: (value) =>
      redactValueWith(redactString, value, new WeakSet<object>(), new WeakMap<object, unknown>()),
  };
};
