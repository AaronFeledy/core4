/**
 * Bug-report redaction helpers used by the CLI failure formatter.
 *
 * Matches the shape of `plugins/provider-lando/src/redact.ts`: redacts
 * value-side substrings of `NAME=value` env-style assignments where the
 * name looks like a credential, and replaces values under
 * credential-looking object keys with `[REDACTED]`. This is the same
 * policy `EventService` and `ShellRunner`/`BunSelfRunner` apply to event
 * payloads per §3.4 and §11.2, so failure output cannot leak
 * secrets/prompt answers that the runtime itself has redacted from its
 * lifecycle events.
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
