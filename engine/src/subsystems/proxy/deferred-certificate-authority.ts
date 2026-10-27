import { Effect, Layer } from "effect";

import { CaError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";

import { CertificateAuthorityResolver } from "../../plugins/certificate-authority-resolver.ts";

const resolutionError = (cause: unknown): CaError => {
  const fromCause =
    typeof cause === "object" &&
    cause !== null &&
    "remediation" in cause &&
    typeof cause.remediation === "string" &&
    cause.remediation.trim().length > 0
      ? cause.remediation
      : undefined;
  return new CaError({
    message: "Unable to resolve the active certificate authority.",
    caId: "unresolved",
    remediation:
      fromCause ??
      "Install a certificate-authority plugin with `lando setup` and select it as the active CA, then re-run.",
    cause,
  });
};

export const layer = Layer.effect(
  CertificateAuthority,
  Effect.gen(function* () {
    const resolver = yield* CertificateAuthorityResolver;
    const resolve = yield* Effect.cached(resolver.resolve.pipe(Effect.mapError(resolutionError)));
    return CertificateAuthority.of({
      id: "deferred",
      setup: (options) => Effect.flatMap(resolve, (authority) => authority.setup(options)),
      issueCert: (spec) => Effect.flatMap(resolve, (authority) => authority.issueCert(spec)),
    });
  }),
);
