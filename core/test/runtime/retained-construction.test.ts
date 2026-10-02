import "@lando/core/bundled-plugins";
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { openLandoRuntime } from "@lando/core";
import { FileSystem } from "@lando/core/services";
import { makeTestRuntime } from "@lando/core/testing";

test("retained runtime constructs with typed host services and releases its scope", async () => {
  // Given
  const host = makeTestRuntime({ bootstrap: "app", files: { "/test-runtime/input": "host value" } });
  let released = false;
  const resource = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        released = true;
      }),
    ),
  );

  // When
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* openLandoRuntime({
          cwd: "/test-runtime/app",
          plugins: { policy: "bundled-only", layers: [host.layer, resource] },
        });
        return yield* runtime.run(
          Effect.flatMap(FileSystem, (files) => files.readFile("/test-runtime/input")),
        );
      }),
    ),
  );

  // Then
  expect(value).toBe("host value");
  expect(released).toBe(true);
});
