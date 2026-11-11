import { mapFailures } from "@lando/sdk/command-result";
import { Effect, Layer } from "effect";

import { CaError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";

import { CertificateAuthorityResolver } from "../../plugins/certificate-authority-resolver.ts";
import { taggedErrorRemediation } from "../../providers/managed.ts";

const resolutionError = (cause: unknown): CaError =>
  new CaError({
    message: "Unable to resolve the active certificate authority.",
    caId: "unresolved",
    remediation:
      taggedErrorRemediation(cause) ??
      "Install a certificate-authority plugin with `lando setup` and select it as the active CA, then re-run.",
    cause,
  });

export const layer = Layer.effect(
  CertificateAuthority,
  Effect.gen(function* () {
    const resolver = yield* CertificateAuthorityResolver;
    const resolve = yield* Effect.cached(resolver.resolve.pipe(mapFailures(resolutionError)));
    return CertificateAuthority.of({
      id: "deferred",
      setup: (options) => Effect.flatMap(resolve, (authority) => authority.setup(options)),
      root: Effect.flatMap(resolve, (authority) => authority.root),
      issueCert: (spec) => Effect.flatMap(resolve, (authority) => authority.issueCert(spec)),
    });
  }),
);
