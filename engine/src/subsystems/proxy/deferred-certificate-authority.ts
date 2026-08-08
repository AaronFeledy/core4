import { Effect, Layer } from "effect";

import { CaError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";

import { CertificateAuthorityResolver } from "../../plugins/certificate-authority-resolver.ts";

const resolutionError = (cause: unknown): CaError => {
  const remediation =
    typeof cause === "object" &&
    cause !== null &&
    "remediation" in cause &&
    typeof cause.remediation === "string"
      ? ` ${cause.remediation}`
      : "";
  return new CaError({
    message: `Unable to resolve the active certificate authority.${remediation}`,
    caId: "unresolved",
    cause,
  });
};

export const DeferredCertificateAuthorityLive = Layer.effect(
  CertificateAuthority,
  Effect.gen(function* () {
    const resolver = yield* CertificateAuthorityResolver;
    const resolve = yield* Effect.cached(resolver.resolve.pipe(Effect.mapError(resolutionError)));
    return {
      id: "deferred",
      setup: (options) => Effect.flatMap(resolve, (authority) => authority.setup(options)),
      issueCert: (spec) => Effect.flatMap(resolve, (authority) => authority.issueCert(spec)),
    };
  }),
);
