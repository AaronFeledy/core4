/**
 * Redaction helpers used by the CLI failure formatter.
 */

const REDACTED = "[REDACTED]" as const;

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]}]+)/gu;

export const redactString = (value: string): string =>
  value.replace(SECRET_ENV_PATTERN, (_, name) => `${String(name)}=${REDACTED}`);

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
