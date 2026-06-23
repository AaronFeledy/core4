import { createRedactor } from "@lando/sdk/secrets";

const secretsRedactor = createRedactor("secrets");

export const redactString = (value: string): string => secretsRedactor.redactString(value);

export const redactDetails = (value: unknown): unknown => secretsRedactor.redactValue(value);

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
