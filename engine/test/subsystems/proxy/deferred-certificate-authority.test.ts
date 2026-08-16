import { describe, expect, test } from "bun:test";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";

import { CaError, NoCertificateAuthorityError } from "@lando/sdk/errors";
import { CertificateAuthority } from "@lando/sdk/services";

import {
  CertificateAuthorityResolver,
  type CertificateAuthorityResolverShape,
} from "../../../src/plugins/certificate-authority-resolver.ts";
import { DeferredCertificateAuthorityLive } from "../../../src/subsystems/proxy/deferred-certificate-authority.ts";

const buildAuthority = (resolver: CertificateAuthorityResolverShape) =>
  Effect.scoped(
    Effect.map(
      Layer.build(
        DeferredCertificateAuthorityLive.pipe(
          Layer.provide(Layer.succeed(CertificateAuthorityResolver, resolver)),
        ),
      ),
      (context) => Context.get(context, CertificateAuthority),
    ),
  );

describe("deferred proxy certificate authority", () => {
  test("does not resolve the active authority while its layer is built", async () => {
    // Given: a resolver whose acquisition is observable.
    let resolutions = 0;
    const resolver: CertificateAuthorityResolverShape = {
      resolve: Effect.sync(() => {
        resolutions += 1;
        return {
          id: "test-ca",
          setup: () => Effect.void,
          issueCert: () => Effect.succeed({ certPath: "/cert", keyPath: "/key", caPath: "/ca" }),
        };
      }),
    };

    // When: the generic deferred layer is built.
    await Effect.runPromise(buildAuthority(resolver));

    // Then: selection has not happened.
    expect(resolutions).toBe(0);
  });

  test("resolves once on first operation and delegates subsequent operations", async () => {
    // Given: a resolver with a reusable active authority.
    let resolutions = 0;
    const resolver: CertificateAuthorityResolverShape = {
      resolve: Effect.sync(() => {
        resolutions += 1;
        return {
          id: "test-ca",
          setup: () => Effect.void,
          issueCert: () => Effect.succeed({ certPath: "/cert", keyPath: "/key", caPath: "/ca" }),
        };
      }),
    };
    const authority = await Effect.runPromise(buildAuthority(resolver));

    // When: setup and issuance are invoked.
    await Effect.runPromise(authority.setup({ force: false }));
    await Effect.runPromise(authority.issueCert({ cn: "demo.test", sans: ["demo.test"] }));

    // Then: the resolver is lazy and cached.
    expect(resolutions).toBe(1);
  });

  test("folds resolver remediation into CaError and preserves the tagged cause", async () => {
    // Given: active-CA selection fails with remediation.
    const selectionFailure = new NoCertificateAuthorityError({
      message: "No certificate authority is available.",
      candidates: [],
      remediation: "Enable the mkcert plugin.",
    });
    const authority = await Effect.runPromise(buildAuthority({ resolve: Effect.fail(selectionFailure) }));

    // When: the deferred authority is first used.
    const exit = await Effect.runPromiseExit(authority.setup({ force: false }));

    // Then: callers receive CaError with actionable text and the original tagged error.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof CaError).toBe(true);
      if (Option.isSome(failure) && failure.value instanceof CaError) {
        expect(failure.value.message).toContain("Enable the mkcert plugin.");
        expect(failure.value.cause).toBe(selectionFailure);
      }
    }
  });
});
