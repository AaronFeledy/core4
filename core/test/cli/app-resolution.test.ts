import { describe, expect, test } from "bun:test";
import { type Context, Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import { assertUserAppIdNotReserved, loadUserLandofile } from "../../src/cli/app-resolution.ts";

const landofile = (name?: string): LandofileShape =>
  (name === undefined ? {} : { name }) as unknown as LandofileShape;

const fakeLandofileService = (shape: LandofileShape): Context.Tag.Service<typeof LandofileService> =>
  ({ discover: Effect.succeed(shape) }) as Context.Tag.Service<typeof LandofileService>;

describe("user-app reserved-id guard", () => {
  test("assertUserAppIdNotReserved fails for the reserved id global", async () => {
    const error = await Effect.runPromise(Effect.flip(assertUserAppIdNotReserved(landofile("global"))));

    expect(error._tag).toBe("AppIdReservedError");
    expect(error.reserved).toBe("global");
  });

  test("assertUserAppIdNotReserved passes for a normal app name", async () => {
    await Effect.runPromise(assertUserAppIdNotReserved(landofile("myapp")));
  });

  test("assertUserAppIdNotReserved passes when no name is declared", async () => {
    await Effect.runPromise(assertUserAppIdNotReserved(landofile()));
  });

  test("loadUserLandofile rejects a Landofile named global before returning it", async () => {
    const error = await Effect.runPromise(
      Effect.flip(loadUserLandofile(fakeLandofileService(landofile("global")))),
    );

    expect(error._tag).toBe("AppIdReservedError");
  });

  test("loadUserLandofile returns the discovered Landofile for a normal app", async () => {
    const result = await Effect.runPromise(loadUserLandofile(fakeLandofileService(landofile("myapp"))));

    expect(result.name).toBe("myapp");
  });
});
