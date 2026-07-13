import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import type { LandofileService } from "@lando/sdk/services";

import {
  assertUserAppIdNotReserved,
  loadUserLandofile,
  loadUserLandofileAt,
  loadUserLandofileFile,
} from "../../src/cli/app-resolution.ts";

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
      const actual: unknown = result;

      expect(actual).toEqual({ name: "myapp", services: { web: { type: "node" } } });
    } finally {
      process.chdir(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads includes from an explicit Landofile file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-app-resolution-file-"));
    try {
      await writeFile(join(dir, ".lando.base.yml"), 'lando: ">=999.0.0"\n', "utf8");
      await writeFile(join(dir, ".lando.yml"), "name: discovered\n", "utf8");
      await writeFile(join(dir, "custom.lando.yml"), "name: custom\nincludes:\n  - ./fragment.yml\n", "utf8");
      await writeFile(join(dir, "fragment.yml"), "services:\n  web:\n    type: node\n", "utf8");

      const result = await Effect.runPromise(loadUserLandofileFile(join(dir, "custom.lando.yml")));
      const actual: unknown = result;

      expect(actual).toEqual({ name: "custom", services: { web: { type: "node" } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("enforces sibling layer constraints for an explicit normative Landofile path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-app-resolution-layers-"));
    try {
      const basePath = join(dir, ".lando.base.yml");
      await writeFile(basePath, 'lando: ">=999.0.0"\n', "utf8");
      await writeFile(join(dir, ".lando.yml"), "name: layered\n", "utf8");

      const error = await Effect.runPromise(Effect.flip(loadUserLandofileFile(join(dir, ".lando.yml"))));

      expect(error._tag).toBe("LandofileVersionConstraintError");
      if (error._tag !== "LandofileVersionConstraintError") throw error;
      expect(error.constraints).toEqual([{ range: ">=999.0.0", source: basePath, layer: "base", order: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadUserLandofileAt root-aware seam", () => {
  test("resolves at an explicit root and restores the host cwd", async () => {
    const left = await realpath(await mkdtemp(join(tmpdir(), "lando-at-left-")));
    const right = await realpath(await mkdtemp(join(tmpdir(), "lando-at-right-")));
    const previous = process.cwd();
    process.chdir(left);
    try {
      let observedCwd = "";
      const service = {
        discover: Effect.sync(() => {
          observedCwd = process.cwd();
          return landofile("at-root");
        }),
      } as Context.Tag.Service<typeof LandofileService>;

      const result = await Effect.runPromise(loadUserLandofileAt(service, right));

      expect(result.name).toBe("at-root");
      expect(observedCwd).toBe(right);
      expect(process.cwd()).toBe(left);
    } finally {
      process.chdir(previous);
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });

  test("does not change the host cwd when root already is the current directory", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-at-same-")));
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const service = fakeLandofileService(landofile("here"));
      const result = await Effect.runPromise(loadUserLandofileAt(service, dir));

      expect(result.name).toBe("here");
      expect(process.cwd()).toBe(dir);
    } finally {
      process.chdir(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes same-root resolution while another chdir region is active", async () => {
    const left = await realpath(await mkdtemp(join(tmpdir(), "lando-at-race-left-")));
    const right = await realpath(await mkdtemp(join(tmpdir(), "lando-at-race-right-")));
    const previous = process.cwd();
    let releaseFirst: (() => void) | undefined;
    let allowSecondObserve: (() => void) | undefined;
    process.chdir(left);
    try {
      const firstCanRestore = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEntered!: () => void;
      const firstInDiscover = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const secondMayObserve = new Promise<void>((resolve) => {
        allowSecondObserve = resolve;
      });
      let secondObserved = "";

      const firstService = {
        discover: Effect.promise(async () => {
          firstEntered();
          await firstCanRestore;
          return landofile("first");
        }),
      } as Context.Tag.Service<typeof LandofileService>;
      const secondService = {
        discover: Effect.promise(async () => {
          await secondMayObserve;
          secondObserved = process.cwd();
          return landofile("second");
        }),
      } as Context.Tag.Service<typeof LandofileService>;

      const first = Effect.runPromise(loadUserLandofileAt(firstService, right));
      await firstInDiscover;
      const second = Effect.runPromise(
        loadUserLandofileAt(secondService, right).pipe(Effect.timeout("1 second")),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseFirst?.();
      await first;
      allowSecondObserve?.();
      const secondResult = await second;

      expect(secondResult.name).toBe("second");
      expect(secondObserved).toBe(right);
      expect(process.cwd()).toBe(left);
    } finally {
      releaseFirst?.();
      allowSecondObserve?.();
      process.chdir(previous);
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });
});
