const REDACTED = "[REDACTED]" as const;

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;

const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]\}]+)/gu;

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

// Podman/Docker API error responses are JSON: `{ cause, message, response }`.
const apiReasonFromBody = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null || !("body" in details)) return undefined;
  const body = (details as { body?: unknown }).body;
  if (typeof body !== "string" || body.trim().length === 0) return undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = (parsed as { message?: unknown; cause?: unknown }).message;
      const fallback = (parsed as { message?: unknown; cause?: unknown }).cause;
      if (typeof candidate === "string" && candidate.trim().length > 0) reason = candidate.trim();
      else if (typeof fallback === "string" && fallback.trim().length > 0) reason = fallback.trim();
    }
  } catch {
    return undefined;
  }
  return reason === undefined ? undefined : redactString(reason);
};

export const withApiReason = (message: string, details: unknown): string => {
  const reason = apiReasonFromBody(details);
  return reason === undefined ? message : `${message} ${reason}`;
};
