import { expect, test } from "bun:test";
import { Context, Effect, Layer, Option } from "effect";

import { DataMover } from "@lando/sdk/services";

import { makeLandoRuntime } from "../../src/index.ts";

test("provider bootstrap exposes DataMover while minimal bootstrap does not", async () => {
  // Given: provider and minimal runtime bootstrap layers.
  const providerLayer = makeLandoRuntime({ bootstrap: "provider" });
  const minimalLayer = makeLandoRuntime({ bootstrap: "minimal" });

  // When: both layers are built.
  const providerContext = await Effect.runPromise(Effect.scoped(Layer.build(providerLayer)));
  const minimalContext = await Effect.runPromise(Effect.scoped(Layer.build(minimalLayer)));

  // Then: only the provider bootstrap includes DataMover.
  expect(Option.isSome(Context.getOption(providerContext, DataMover))).toBe(true);
  expect(Option.isNone(Context.getOption(minimalContext, DataMover))).toBe(true);
});
