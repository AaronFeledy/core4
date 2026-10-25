import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { Redactor } from "@lando/sdk/secrets";
import { Context, Effect, Option } from "effect";
import type { ProviderErrorContext } from "./engine-api.ts";

/**
 * Resolve the redactor for a provider error context: retained redactor wins,
 * else a standalone built from the context's explicit env snapshot.
 * Never reads process.env; callers must pass ctx.env.
 */
export const redactorFor = (ctx: ProviderErrorContext): Redactor =>
  ctx.redactor ?? createStandaloneRedactor("secrets", { sourceEnv: ctx.env });

/** Host-boundary standalone secrets redactor from an explicit env snapshot. Never reads process.env. */
export const standaloneSecretsRedactor = (
  sourceEnv: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly authoritativeTokens?: Iterable<string>;
    readonly redactionTokens?: Iterable<string>;
  },
): Redactor =>
  createStandaloneRedactor("secrets", {
    sourceEnv,
    ...(options?.authoritativeTokens === undefined
      ? {}
      : { authoritativeTokens: options.authoritativeTokens }),
    ...(options?.redactionTokens === undefined ? {} : { redactionTokens: options.redactionTokens }),
  });

export const runtimeDiagnosticContext = Effect.fnUntraced(function* (ctx: ProviderErrorContext) {
  const service = yield* Effect.serviceOption(RedactionService);
  const options = { sourceEnv: ctx.env };
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : (ctx.redactor ?? createStandaloneRedactor("secrets", options));
  return { ...ctx, redactor };
});

/**
 * Engine-supplied start-failure log redactor. No default empty env: callers must
 * provide via Effect.provideService, or captureServiceLogTail falls back to redactorFor(ctx).
 */
export class StartFailureLogRedactor extends Context.Service<StartFailureLogRedactor, Redactor>()(
  "@lando/container-runtime/StartFailureLogRedactor",
) {}

export const redactString = (value: string, redactor: Redactor): string => redactor.redactString(value);

export const redactDetails = (value: unknown, redactor: Redactor): unknown => redactor.redactValue(value);

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
  redactor: Redactor,
): unknown => redactDetails(httpResponseDetails(response), redactor);

const apiReasonFromBody = (details: unknown, redactor: Redactor): string | undefined => {
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

export const withApiReason = (message: string, details: unknown, redactor: Redactor): string => {
  const reason = apiReasonFromBody(details, redactor);
  return reason === undefined ? message : `${message} ${reason}`;
};
