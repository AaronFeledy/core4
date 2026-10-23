import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";
import { Context, Effect, Option } from "effect";
import type { ProviderErrorContext } from "./engine-api.ts";

// Standalone callers get pattern masking only; runtime callers pass their retained redactor.
const secretsRedactor = createStandaloneRedactor("secrets");

export const runtimeDiagnosticContext = Effect.fnUntraced(function* (ctx: ProviderErrorContext) {
  const service = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets")
    : (ctx.redactor ?? secretsRedactor);
  return { ...ctx, redactor };
});

// The engine supplies its canonical redactor without coupling container helpers to the secret store.
export const StartFailureLogRedactor = Context.Reference<Redactor>(
  "@lando/container-runtime/StartFailureLogRedactor",
  { defaultValue: () => secretsRedactor },
);

export const redactString = (value: string, redactor: Redactor = secretsRedactor): string =>
  redactor.redactString(value);

export const redactDetails = (value: unknown, redactor: Redactor = secretsRedactor): unknown =>
  redactor.redactValue(value);

export const httpResponseDetails = (response: {
  readonly status: number;
  readonly body: string;
}): { readonly status: number; readonly body: string } => ({
  status: response.status,
  body: response.body,
});

export const redactResponseDetails = (
  response: {
    readonly status: number;
    readonly body: string;
  },
  redactor?: Redactor,
): unknown => redactDetails(httpResponseDetails(response), redactor);

const apiReasonFromBody = (details: unknown, redactor?: Redactor): string | undefined => {
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
  return reason === undefined ? undefined : redactString(reason, redactor);
};

export const withApiReason = (message: string, details: unknown, redactor?: Redactor): string => {
  const reason = apiReasonFromBody(details, redactor);
  return reason === undefined ? message : `${message} ${reason}`;
};
