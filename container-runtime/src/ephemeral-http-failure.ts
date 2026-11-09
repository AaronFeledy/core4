import { redactProviderError } from "@lando/redaction/provider-error";
import { collectUrlCredentialValues, createStandaloneRedactor } from "@lando/redaction/service";
import { internalErrorRemediation } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { REDACTED } from "@lando/sdk/secrets";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Effect } from "effect";
import type { DataPlaneHttpResponse, ProviderDataPlaneOptions } from "./data-plane.ts";
import { apiReasonFromBody } from "./redact.ts";

export const runtimeRemediation =
  "Run `lando doctor` to check the container runtime, then retry the command.";
export const internalRemediation = internalErrorRemediation;

const actions = {
  "run.create": "create Lando's helper container",
  "run.start": "start Lando's helper container",
  "run.wait": "wait for Lando's helper container to finish",
  "run.inspect": "read Lando's helper container's result",
  "run.volume": "create storage for Lando's helper container",
} as const;

export const ensureEphemeral2xx = (
  options: ProviderDataPlaneOptions,
  spec: EphemeralRunSpec,
  failure: { readonly operation: keyof typeof actions; readonly response: DataPlaneHttpResponse },
): Effect.Effect<void, ProviderUnavailableError> => {
  const { operation, response } = failure;
  if (
    operation === "run.volume"
      ? [200, 201, 409].includes(response.status)
      : response.status >= 200 && response.status < 300
  )
    return Effect.void;
  return Effect.gen(function* () {
    // Credentials belong in env, never argv. Compile one matcher so overlapping tokens stay intact.
    const values = Object.values(spec.env ?? {});
    const tokens = { authoritativeTokens: [...values, ...collectUrlCredentialValues(values)] };
    const redactor =
      options.redactorFor === undefined
        ? createStandaloneRedactor("secrets", { ...tokens, sourceEnv: {} })
        : yield* options.redactorFor(tokens);
    const reason = apiReasonFromBody(response, redactor)?.trim();
    const buffer = new Uint8Array(512);
    const encoded = new TextEncoder().encodeInto(reason ?? "", buffer);
    const clipped = new TextDecoder().decode(buffer.subarray(0, encoded.written));
    const redactedReason =
      reason === undefined || reason === REDACTED || reason.length === 0
        ? undefined
        : redactor.redactString(clipped);
    const safeReason =
      redactedReason !== undefined && new TextEncoder().encode(redactedReason).byteLength > 512
        ? undefined
        : redactedReason;
    const status = `HTTP ${response.status}`;
    const base = redactProviderError(
      new ProviderUnavailableError({
        providerId: options.providerId,
        operation,
        message: `The container engine couldn't ${actions[operation]} (${status}).`,
        remediation: runtimeRemediation,
        details: { status: response.status },
      }),
      options.redactor,
    );
    return yield* Effect.fail(
      new ProviderUnavailableError({
        ...base,
        message:
          safeReason === undefined || safeReason === REDACTED
            ? base.message
            : `${base.message.slice(0, -2)}: ${safeReason}).`,
      }),
    );
  });
};
