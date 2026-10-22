import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { ConfigError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { GlobalConfig, PluginManifest } from "@lando/sdk/schema";
import { ConfigService, PathsService, SecretStore } from "@lando/sdk/services";
import { Effect, Layer, Result, Schema } from "effect";
import * as ConfigLayer from "../../src/services/config";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";

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
      Layer.succeed(
        SecretStore,
        SecretStore.of({
          id,
          schemes,
          get: (ref) => Effect.succeed(`${id}:${ref}`),
          has: () => Effect.succeed(true),
          list: Effect.succeed([`${schemes[0]}://Vault/Item/field`]),
        }),
      ),
    ],
  ]),
});

const run = async <A, E>(
  effect: Effect.Effect<A, E, SecretStore>,
  options: {
    readonly modules?: readonly LandoPluginModule[];
    readonly defaultSecretStore?: string;
  } = {},
) => {
  const RoutedSecretStore = await import("../../src/services/secret-store-registry.ts");
  const config = Schema.decodeUnknownSync(GlobalConfig)(
    options.defaultSecretStore === undefined ? {} : { defaultSecretStore: options.defaultSecretStore },
  );
  const layer = RoutedSecretStore.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RoutedSecretStore.SecretStoreRegistry.layer(options.modules ?? [moduleFor("vault", ["op"])]),
        Layer.succeed(
          ConfigService,
          ConfigService.of({
            load: Effect.succeed(config),
            get: (key) => Effect.succeed(config[key]),
          }),
        ),
        Layer.succeed(PathsService, makeLandoPaths()),
        BunFileSystem.layer,
        BunProcessRunner.layer,
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
    Effect.flatMap(SecretStore, (store) => Effect.result(store.get("W1_A_ABSENT_TOKEN"))),
  );
  // Then
  expect(value).toBe("vault:TOKEN");
  expect(Result.isFailure(fallback) && fallback.failure._tag).toBe("SecretNotFoundError");
});

test.each(["unknown://Vault/Item/field", "op://Vault//field"])(
  "unknown scheme or malformed ref fails SecretReferenceInvalidError: %s",
  async (ref) => {
    // Given / When
    const result = await run(Effect.flatMap(SecretStore, (store) => Effect.result(store.get(ref))));
    // Then
    expect(Result.isFailure(result) && result.failure._tag).toBe("SecretReferenceInvalidError");
  },
);

test("unknown default store fails SecretReferenceInvalidError", async () => {
  // Given / When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => Effect.result(store.get("TOKEN"))),
    { defaultSecretStore: "missing" },
  );
  // Then
  expect(Result.isFailure(result) && result.failure._tag).toBe("SecretReferenceInvalidError");
});

test("duplicate schemes fail registry construction", async () => {
  // Given
  const RoutedSecretStore = await import("../../src/services/secret-store-registry.ts");
  // When
  const result = await Effect.runPromise(
    Effect.result(
      RoutedSecretStore.SecretStoreRegistry.pipe(
        Effect.provide(
          RoutedSecretStore.SecretStoreRegistry.layer([
            moduleFor("first", ["op"]),
            moduleFor("second", ["op"]),
          ]),
        ),
      ),
    ),
  );
  // Then
  expect(Result.isFailure(result) && result.failure._tag).toBe("LandoRuntimeBootstrapError");
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

test("invalid defaultSecretStore fails config construction before secret routing", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Layer.build(
          ConfigLayer.layerWith({
            env: {},
            sources: { user: false, env: false },
            host: { defaultSecretStore: 42 },
          }),
        ),
      ),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(ConfigError);
    expect(result.failure.issues?.[0]?.path).toEqual(["defaultSecretStore"]);
    expect(result.failure.issues?.[0]?.source?.layer).toBe("host");
  }
});

test("bare ids fail when defaultSecretStore only accepts scheme references", async () => {
  // Given: 1password declares the op scheme and is selected for bare ids.
  // When
  const result = await run(
    Effect.flatMap(SecretStore, (store) => Effect.result(store.get("TOKEN"))),
    { modules: [moduleFor("1password", ["op"])], defaultSecretStore: "1password" },
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result) && result.failure._tag === "SecretReferenceInvalidError") {
    expect(result.failure.message).toContain("1password");
    expect(result.failure.message).toContain("bare");
    expect(result.failure.remediation).toContain("defaultSecretStore");
    expect(result.failure.remediation).toContain("env");
    expect(result.failure.remediation).toContain("scheme");
    return;
  }
  expect.unreachable("expected a SecretReferenceInvalidError failure");
});
