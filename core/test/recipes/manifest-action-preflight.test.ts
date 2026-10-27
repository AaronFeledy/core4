import { expect, test } from "bun:test";
import { RecipeManifestService } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { layer } from "../../src/recipes/manifest/service.ts";

test.each([
  "  - type: bun\n    verb: add",
  "  - type: bun\n    verb: add\n    dependencies:\n      - --global",
  "  - type: gitInit",
])("rejects invalid source actions through the manifest service: %s", async (action) => {
  // Given authored source with valid config but an invalid post-init action.
  const source = `id: invalid-action
title: Invalid action
description: Action preflight fixture
version: 1.0.0
config:
  runtime: 4
  services:
    app:
      type: lando
      image: alpine:3.21
postInit:
${action}
`;
  // When callers use the actual public service parse path.
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const service = yield* RecipeManifestService;
        return yield* service.parse("test://invalid-action", source);
      }).pipe(Effect.provide(layer)),
    ),
  );
  // Then semantic validation rejects the action at its structured path.
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "RecipeManifestValidationError",
    issues: [{ path: ["postInit", 0] }],
  });
});
