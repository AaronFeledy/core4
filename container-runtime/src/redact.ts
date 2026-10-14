import { createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";
import { Context } from "effect";

// Provider diagnostics must observe secret values registered after this shim is imported.
const secretsRedactor = createStandaloneRedactor("secrets");

// The engine supplies its canonical redactor without coupling container helpers to the secret store.
export const StartFailureLogRedactor = Context.Reference<Redactor>(
  "@lando/container-runtime/StartFailureLogRedactor",
  { defaultValue: () => secretsRedactor },
);

export const redactString = (value: string): string => secretsRedactor.redactString(value);

export const redactDetails = (value: unknown): unknown => secretsRedactor.redactValue(value);

export const httpResponseDetails = (response: {
  readonly status: number;
  readonly body: string;
}): { readonly status: number; readonly body: string } => ({
  status: response.status,
  body: response.body,
});

export const redactResponseDetails = (response: {
  readonly status: number;
  readonly body: string;
}): unknown => redactDetails(httpResponseDetails(response));

const apiReasonFromBody = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null || !("body" in details)) return undefined;
  const body = details.body;
  if (typeof body !== "string" || body.trim().length === 0) return undefined;
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = "message" in parsed ? parsed.message : undefined;
      const fallback = "cause" in parsed ? parsed.cause : undefined;
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
