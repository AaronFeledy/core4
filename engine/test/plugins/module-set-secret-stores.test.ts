import { expect, test } from "bun:test";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { SecretStore } from "@lando/sdk/services";
import { Effect, Either, Layer, Schema } from "effect";
import { makePluginCapabilityIndex } from "../../src/plugins/module-set.ts";

const module: LandoPluginModule = {
  name: "@test/secrets",
  manifest: Schema.decodeUnknownSync(PluginManifest)({
    name: "@test/secrets",
    version: "1.0.0",
    api: 4,
    contributes: { secretStores: [{ id: "vault", schemes: ["op"], module: "./store.ts" }] },
  }),
  secretStores: new Map([
    [
      "vault",
      Layer.succeed(SecretStore, {
        id: "vault",
        get: () => Effect.succeed("canary"),
        has: () => Effect.succeed(true),
        list: Effect.succeed([]),
      }),
    ],
  ]),
};

test("indexes secretStores contributions", () => {
  // Given / When
  const result = makePluginCapabilityIndex([module]);
  // Then
  expect(Either.getOrThrow(result).secretStores.get("vault")).toBe(module.secretStores?.get("vault"));
});

test("rejects a manifest id the module does not export", () => {
  // Given / When
  const result = makePluginCapabilityIndex([{ ...module, secretStores: new Map() }]);
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("PluginDescriptorMismatchError");
});
