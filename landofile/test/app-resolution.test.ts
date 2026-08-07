import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { type Context, Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { makeUserAppResolution } from "@lando/landofile/app-resolution";

const makeResolution = () =>
  makeUserAppResolution({
    assertVersionConstraint: () => Effect.void,
  });

const serviceFor = (shape: LandofileShape): Context.Tag.Service<typeof LandofileService> => ({
  discover: Effect.succeed(shape),
});

describe("user app resolution seam", () => {
  test("loadUserLandofile returns the discovered Landofile for a normal app", async () => {
    // Given
    const resolution = makeResolution();
    const service = serviceFor({ name: "myapp" });

    // When
    const result = await Effect.runPromise(resolution.loadUserLandofile(service));

    // Then
    expect(result.name).toBe("myapp");
  });

  test("loadUserLandofileAt serializes concurrent root resolution and restores cwd", async () => {
    // Given
    const firstResolution = makeResolution();
    const secondResolution = makeResolution();
    const left = await realpath(await mkdtemp(join(tmpdir(), "lando-resolution-left-")));
    const right = await realpath(await mkdtemp(join(tmpdir(), "lando-resolution-right-")));
    const previous = process.cwd();
    const firstCanRestore = Promise.withResolvers<void>();
    const firstInDiscover = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const secondMayObserve = Promise.withResolvers<void>();
    process.chdir(left);

    try {
      let secondObserved = "";
      const firstService = {
        discover: Effect.promise(async () => {
          firstInDiscover.resolve();
          await firstCanRestore.promise;
          return { name: "first" };
        }),
      } satisfies Context.Tag.Service<typeof LandofileService>;
      const secondService = {
        discover: Effect.promise(async () => {
          await secondMayObserve.promise;
          secondObserved = process.cwd();
          return { name: "second" };
        }),
      } satisfies Context.Tag.Service<typeof LandofileService>;

      // When
      const first = Effect.runPromise(firstResolution.loadUserLandofileAt(firstService, right));
      await firstInDiscover.promise;
      const second = Effect.runPromise(
        Effect.sync(() => secondStarted.resolve()).pipe(
          Effect.zipRight(secondResolution.loadUserLandofileAt(secondService, right)),
          Effect.timeout("1 second"),
        ),
      );
      await secondStarted.promise;
      firstCanRestore.resolve();
      await first;
      secondMayObserve.resolve();
      const secondResult = await second;

      // Then
      expect(secondResult.name).toBe("second");
      expect(secondObserved).toBe(right);
      expect(process.cwd()).toBe(left);
    } finally {
      firstCanRestore.resolve();
      secondMayObserve.resolve();
      process.chdir(previous);
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });
});
