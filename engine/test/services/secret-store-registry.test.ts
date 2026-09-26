import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { ConfigError, SecretReferenceInvalidError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { GlobalConfig, PluginManifest } from "@lando/sdk/schema";
import { ConfigService, PathsService, SecretStore } from "@lando/sdk/services";
import { Effect, Either, Layer, Schema } from "effect";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { ProcessRunnerLive } from "../../src/services/process-runner.ts";

const moduleFor = (id: string, schemes: readonly string[]): LandoPluginModule => ({
  name: `@test/${id}`,
  manifest: Schema.decodeUnknownSync(PluginManifest)({
    name: `@test/${id}`,
    version: "1.0.0",
    api: 4,
    contributes: { secretStores: [{ id, schemes, module: "./store.ts" }] },
  }),
  secretStores: new Map([
    [
      id,
      Layer.succeed(SecretStore, {
        id,
        schemes,
        get: (ref) => Effect.succeed(`${id}:${ref}`),
        has: () => Effect.succeed(true),
        list: Effect.succeed([`${schemes[0]}://Vault/Item/field`]),
      }),
    ],
  ]),
});

const run = async <A, E>(
  effect: Effect.Effect<A, E, SecretStore>,
  options: {
    readonly modules?: readonly LandoPluginModule[];
    readonly defaultSecretStore?: string;
    readonly configError?: boolean;
  } = {},
) => {
  const { makeSecretStoreRegistryLive, RoutedSecretStoreLive } = await import(
    "../../src/services/secret-store-registry.ts"
  );
  const config = Schema.decodeUnknownSync(GlobalConfig)(
    options.defaultSecretStore === undefined ? {} : { defaultSecretStore: options.defaultSecretStore },
  );
  const layer = RoutedSecretStoreLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeSecretStoreRegistryLive(options.modules ?? [moduleFor("vault", ["op"])]),
        Layer.succeed(ConfigService, {
          load: Effect.succeed(config),
          get: (key) =>
            options.configError === true && key === "defaultSecretStore"
              ? Effect.fail(
                  new ConfigError({
                    message: "Lando config could not be read.",
                    path: "defaultSecretStore",
                  }),
                )
              : Effect.succeed(config[key]),
        }),
        Layer.succeed(PathsService, makeLandoPaths()),
        FileSystemLive,
        ProcessRunnerLive,
      ),
    ),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

test("routes op:// references to the store owning the scheme", async () => {
  // Given / When
  const value = await run(Effect.flatMap(SecretStore, (store) => store.get("op://Vault/Item/field")));
  // Then
  expect(value).toBe("vault:op://Vault/Item/field");
});

test("bare ids go to defaultSecretStore and fall back to env", async () => {
  // Given / When
  const value = await run(
    Effect.flatMap(SecretStore, (store) => store.get("TOKEN")),
    { modules: [moduleFor("vault", [])], defaultSecretStore: "vault" },
  );
  const fallback = await run(
    Effect.flatMap(SecretStore, (store) => Effect.either(store.get("W1_A_ABSENT_TOKEN"))),
  );
  // Then
  expect(value).toBe("vault:TOKEN");
  expect(Either.isLeft(fallback) && fallback.left._tag).toBe("SecretNotFoundError");
});

test.each(["unknown://Vault/Item/field", "op://Vault//field"])(
  "unknown scheme or malformed ref fails SecretReferenceInvalidError: %s",
  async (ref) => {
    // Given / When
    const result = await run(Effect.flatMap(SecretStore, (store) => Effect.either(store.get(ref))));
    // Then
    expect(Either.isLeft(result) && result.left._tag).toBe("SecretReferenceInvalidError");
  },
);

test("unknown default store fails SecretReferenceInvalidError", async () => {
  // Given / When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => Effect.either(store.get("TOKEN"))),
    { defaultSecretStore: "missing" },
  );
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("SecretReferenceInvalidError");
});

test("duplicate schemes fail registry construction", async () => {
  // Given
  const { SecretStoreRegistry, makeSecretStoreRegistryLive } = await import(
    "../../src/services/secret-store-registry.ts"
  );
  // When
  const result = await Effect.runPromise(
    Effect.either(
      SecretStoreRegistry.pipe(
        Effect.provide(
          makeSecretStoreRegistryLive([moduleFor("first", ["op"]), moduleFor("second", ["op"])]),
        ),
      ),
    ),
  );
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("LandoRuntimeBootstrapError");
});

test("list returns the union of member lists", async () => {
  // Given / When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => store.list),
    { modules: [moduleFor("first", ["op"]), moduleFor("second", ["other"])] },
  );
  // Then
  expect(result).toContain("op://Vault/Item/field");
  expect(result).toContain("other://Vault/Item/field");
});

test("ConfigService failure reading defaultSecretStore is SecretReferenceInvalidError", async () => {
  // Tag choice: SecretReferenceInvalidError. ConfigError is outside SecretStoreError;
  // SecretNotFoundError would claim the secret is missing; SecretStoreUnavailableError's
  // reason enum cannot name a Lando config read failure. Routed has() already collapses
  // SecretReferenceInvalidError to false.
  // Given / When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => Effect.either(store.get("TOKEN"))),
    { configError: true },
  );
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result) && result.left._tag === "SecretReferenceInvalidError") {
    expect(result.left).toBeInstanceOf(SecretReferenceInvalidError);
    expect(result.left.message).toContain("defaultSecretStore");
    expect(result.left.message).toContain("Lando config");
    expect(result.left.remediation).toContain("defaultSecretStore");
    expect(result.left.remediation).not.toContain("owning this scheme");
    return;
  }
  expect.unreachable("expected a SecretReferenceInvalidError failure");
});

test("bare ids fail when defaultSecretStore only accepts scheme references", async () => {
  // Given: 1password declares the op scheme and is selected for bare ids.
  // When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => Effect.either(store.get("TOKEN"))),
    { modules: [moduleFor("1password", ["op"])], defaultSecretStore: "1password" },
  );
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result) && result.left._tag === "SecretReferenceInvalidError") {
    expect(result.left.message).toContain("1password");
    expect(result.left.message).toContain("bare");
    expect(result.left.remediation).toContain("defaultSecretStore");
    expect(result.left.remediation).toContain("env");
    expect(result.left.remediation).toContain("scheme");
    return;
  }
  expect.unreachable("expected a SecretReferenceInvalidError failure");
});
