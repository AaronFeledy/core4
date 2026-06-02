import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("loadUserLandofile includes", () => {
  test("resolves a local include before returning and applying the reserved-id guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-app-resolution-includes-"));
    const previous = process.cwd();
    try {
      await writeFile(join(dir, ".lando.yml"), "name: myapp\n", "utf8");
      await writeFile(join(dir, "fragment.yml"), "services:\n  web:\n    type: node\n", "utf8");
      process.chdir(dir);

      const result = await Effect.runPromise(
        loadUserLandofile(fakeLandofileService({ name: "myapp", includes: ["./fragment.yml"] })),
      );

      expect(result).toEqual({ name: "myapp", services: { web: { type: "node" } } });
    } finally {
      process.chdir(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
