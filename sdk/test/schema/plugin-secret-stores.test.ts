import { expect, test } from "bun:test";
import { PluginManifest } from "@lando/sdk/schema";
import { Either, ParseResult, Schema } from "effect";

test("PluginManifest accepts contributes.secretStores with schemes", () => {
  // Given
  const secretStores = [{ id: "1password", module: "./store.ts", schemes: ["op"] }];
  const input = {
    name: "@lando/secret-store-1password",
    version: "1.0.0",
    api: 4,
    contributes: { secretStores },
  };
  // When
  const manifest = Schema.decodeUnknownSync(PluginManifest)(input, { onExcessProperty: "error" });
  // Then
  expect(manifest.contributes?.secretStores).toEqual(secretStores);
});

test("secretStores rejects a missing schemes array", () => {
  // Given
  const input = {
    name: "@lando/secret-store-1password",
    version: "1.0.0",
    api: 4,
    contributes: { secretStores: [{ id: "1password", module: "./store.ts" }] },
  };
  // When
  const result = Schema.decodeUnknownEither(PluginManifest)(input, { onExcessProperty: "error" });
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(ParseResult.ArrayFormatter.formatErrorSync(result.left)).toContainEqual(
      expect.objectContaining({ _tag: "Missing", path: ["contributes", "secretStores", 0, "schemes"] }),
    );
  }
});
