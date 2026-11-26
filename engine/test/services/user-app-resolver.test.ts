import { describe, expect, test } from "bun:test";
import type { LandofileShape } from "@lando/sdk/schema";
import { AbsolutePath } from "@lando/sdk/schema";
import { LandofileService, UserAppResolver } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

import * as UserAppResolverLayer from "../../src/services/user-app-resolver.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const withResolver = (shape: LandofileShape) =>
  UserAppResolverLayer.layer.pipe(
    Layer.provide(Layer.succeed(LandofileService, { discover: Effect.succeed(literalTestLandofile(shape)) })),
  );

describe("UserAppResolver service", () => {
  test("current rejects a Landofile named global", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const resolver = yield* UserAppResolver;
          return yield* resolver.current;
        }).pipe(Effect.provide(withResolver({ name: "global" }))),
      ),
    );

    expect(error._tag).toBe("AppIdReservedError");
  });

  test("current returns the discovered Landofile for a normal app", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* UserAppResolver;
        return yield* resolver.current;
      }).pipe(Effect.provide(withResolver({ name: "myapp" }))),
    );

    expect(result.document.name).toBe("myapp");
  });

  test("load(root) rejects a Landofile named global at that root", async () => {
    const root = AbsolutePath.make("/tmp/user-app-resolver");
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const resolver = yield* UserAppResolver;
          return yield* resolver.load(root);
        }).pipe(Effect.provide(withResolver({ name: "global" }))),
      ),
    );

    expect(error._tag).toBe("AppIdReservedError");
  });
});
