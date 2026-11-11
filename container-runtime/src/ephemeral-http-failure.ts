import { redactProviderError } from "@lando/redaction/provider-error";
import { collectUrlCredentialValues, createStandaloneRedactor } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { REDACTED } from "@lando/sdk/secrets";
import type { EphemeralRunSpec } from "@lando/sdk/services";
import { Effect } from "effect";
import type { DataPlaneHttpResponse, ProviderDataPlaneOptions } from "./data-plane.ts";
import { apiReasonFromBody } from "./redact.ts";

import { runtimeRemediation } from "./transport-error.ts";
export { runtimeRemediation } from "./transport-error.ts";

const actions = {
  "run.create": "create Lando's helper container",
  "run.start": "start Lando's helper container",
  "run.wait": "wait for Lando's helper container to finish",
  "run.inspect": "read Lando's helper container's result",
  "run.volume": "create storage for Lando's helper container",
  "run.mountsFrom": "read the service container's mounts for Lando's helper container",
} as const;

const reasonLimit = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The reason arrives redacted, so clipping it at a code point cannot expose new secret text. */
const boundedReason = (reason: string | undefined): string | undefined => {
  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed === REDACTED) return undefined;
  const buffer = new Uint8Array(reasonLimit);
  const { read, written } = encoder.encodeInto(trimmed, buffer);
  return read === trimmed.length ? trimmed : `${decoder.decode(buffer.subarray(0, written))}...`;
};

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
    const reason = boundedReason(apiReasonFromBody(response, redactor));
    const status = reason === undefined ? `HTTP ${response.status}` : `HTTP ${response.status}: ${reason}`;
    return yield* Effect.fail(
      redactProviderError(
        new ProviderUnavailableError({
          providerId: options.providerId,
          operation,
          message: `The container engine couldn't ${actions[operation]} (${status}).`,
          remediation: runtimeRemediation,
          details: { status: response.status },
        }),
        options.redactor,
      ),
    );
  });
};
