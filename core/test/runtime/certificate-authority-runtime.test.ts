import { describe, expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";

import { AmbiguousCertificateAuthoritiesError, NoCertificateAuthorityError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { CertificateAuthority } from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { CertificateAuthorityResolver } from "../../src/testing/engine-layers.ts";

const authorityLayer = (id: string) =>
  Layer.succeed(CertificateAuthority, { ...makeTestCertificateAuthority(), id });

const resolvedManifest = (id: string, platforms?: ReadonlyArray<string>) => {
  const manifest = Schema.decodeSync(PluginManifest)({
    name: `@example/${id}`,
    version: "1.0.0",
    api: 4,
    contributes: {
      certificateAuthorities: [
        {
          id,
          module: "./ca.ts",
          ...(platforms === undefined ? {} : { defaultFor: { platform: platforms } }),
        },
      ],
    },
  });
  return {
    manifest,
    entry: definePlugin({
      name: manifest.name,
      manifest,
      certificateAuthorities: new Map([[id, authorityLayer(id)]]),
    }),
  };
};

describe("runtime certificate authority contributions", () => {
  test("constructs provider runtime without a candidate and fails only on resolve", async () => {
    // Given / When
    const context = await Effect.runPromise(
      Effect.scoped(Layer.build(makeLandoRuntime({ bootstrap: "provider", plugins: { policy: "none" } }))),
    );
    const resolver = Context.get(context, CertificateAuthorityResolver);
    const exit = await Effect.runPromiseExit(resolver.resolve);

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof NoCertificateAuthorityError).toBe(true);
    }
  });

  test("retains duplicate raw authorities as distinct ambiguous candidates", async () => {
    // Given / When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "provider",
              plugins: { layers: [authorityLayer("first"), authorityLayer("second")] },
            }),
          );
          return yield* Context.get(context, CertificateAuthorityResolver).resolve;
        }),
      ),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof AmbiguousCertificateAuthoritiesError).toBe(
        true,
      );
    }
  });

  test("uses manifest defaultFor ahead of a raw authority", async () => {
    // Given
    const manifest = resolvedManifest("manifest-default", [process.platform]);

    // When
    const selected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "provider",
              plugins: { layers: [authorityLayer("raw")], manifests: [manifest] },
            }),
          );
          return yield* Context.get(context, CertificateAuthorityResolver).resolve;
        }),
      ),
    );

    // Then
    expect(selected.id).toBe("manifest-default");
  });

  test("applies disable after explicit manifest override", async () => {
    // Given
    const disabled = resolvedManifest("disabled", [process.platform]);

    // When
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "provider",
              plugins: { manifests: [disabled], disable: [disabled.manifest.name] },
            }),
          );
          return yield* Context.get(context, CertificateAuthorityResolver).resolve;
        }),
      ),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof NoCertificateAuthorityError).toBe(true);
    }
  });
});
