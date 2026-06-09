/**
 * Redaction helpers used by the CLI failure formatter.
 */

const REDACTED = "[REDACTED]" as const;

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]}]+)/gu;

// Credentials embedded in a URL authority, e.g. `http://user:pass@proxy:3128`.
// Corporate proxy/download URLs persisted in failure evidence commonly carry these.
const SECRET_URL_USERINFO_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gu;

// `Authorization: Bearer <token>` style values echoed in HTTP error messages.
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[\w.~+/=-]+/giu;

// Secret-bearing query parameters in signed download URLs, e.g. `?token=...`,
// `&access_token=...`, `&X-Amz-Signature=...`. The secret keyword must be a
// whole key component (start-of-key or after a `-`/`_`), so substring matches
// in innocuous params (`?design=...` contains "sig") are not redacted.
const SECRET_QUERY_PARAM_PATTERN =
  /([?&](?:[\w-]*[-_])?(?:access[_-]?token|token|secret|password|passwd|credential|signature|sig|api[_-]?key|apikey)=)([^&\s"'\]}]+)/giu;

export const redactString = (value: string): string =>
  value
    .replace(SECRET_ENV_PATTERN, (_, name) => `${String(name)}=${REDACTED}`)
    .replace(SECRET_URL_USERINFO_PATTERN, (_, scheme) => `${String(scheme)}${REDACTED}@`)
    .replace(BEARER_TOKEN_PATTERN, (_, scheme) => `${String(scheme)} ${REDACTED}`)
    .replace(SECRET_QUERY_PARAM_PATTERN, (_, prefix) => `${String(prefix)}${REDACTED}`);

const redactArray = (value: ReadonlyArray<unknown>): Array<unknown> =>
  value.map((item) => redactDetails(item));

const redactObject = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactDetails(raw);
  }
  return out;
};

export const redactDetails = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return redactArray(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  if (typeof value === "string") return redactString(value);
  return value;
};
