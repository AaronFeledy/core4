import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import type { LandofileShape } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import {
  assertUserAppIdNotReserved,
  loadUserLandofile,
  loadUserLandofileAt,
  loadUserLandofileFile,
} from "../../src/landofile/app-resolution.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import * as TestLandofileServiceLayer from "../services/landofile-layer.ts";

const testStateStoreLayer = makeTestStateStore().layer;

const landofile = (name?: string): LandofileShape => (name === undefined ? {} : { name });

const fakeLandofileService = (shape: LandofileShape): Context.Service.Shape<typeof LandofileService> => ({
  discover: Effect.succeed(literalTestLandofile(shape)),
});

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

    expect(result.document.name).toBe("myapp");
  });
});

describe("loadUserLandofile includes", () => {
  test("resolves a local include before returning and applying the reserved-id guard", async () => {
    // Given
    const dir = await mkdtemp(join(tmpdir(), "lando-app-resolution-includes-"));
    const previous = process.cwd();
    try {
      await writeFile(join(dir, ".lando.yml"), "name: myapp\nincludes:\n  - ./fragment.yml\n", "utf8");
      await writeFile(join(dir, "fragment.yml"), "services:\n  web:\n    type: node\n", "utf8");
      process.chdir(dir);

      // When
      const result = await Effect.runPromise(
        LandofileService.pipe(
          Effect.flatMap(loadUserLandofile),
          Effect.provide(TestLandofileServiceLayer.layer),
        ),
      );
      const actual: unknown = result.document;

      // Then
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

      const result = await Effect.runPromise(
        loadUserLandofileFile(join(dir, "custom.lando.yml")).pipe(Effect.provide(testStateStoreLayer)),
      );
      const actual: unknown = result.document;

      expect(actual).toEqual({ name: "custom", services: { web: { type: "node" } } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads a top-level Compose include from an explicit Landofile file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-app-resolution-compose-include-"));
    try {
      await writeFile(join(dir, "custom.lando.yml"), "name: custom\ninclude:\n  - ./fragment.yml\n", "utf8");
      await writeFile(join(dir, "fragment.yml"), "services:\n  web:\n    type: node\n", "utf8");

      const result = await Effect.runPromise(
        loadUserLandofileFile(join(dir, "custom.lando.yml")).pipe(Effect.provide(testStateStoreLayer)),
      );
      const actual: unknown = result.document;

      expect(actual).toEqual({
        name: "custom",
        services: { web: { type: "node", appMount: false } },
      });
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

      const error = await Effect.runPromise(
        Effect.flip(loadUserLandofileFile(join(dir, ".lando.yml"))).pipe(Effect.provide(testStateStoreLayer)),
      );

      expect(error._tag).toBe("LandofileVersionConstraintError");
      if (error._tag !== "LandofileVersionConstraintError") throw error;
      expect(error.constraints).toEqual([{ range: ">=999.0.0", source: basePath, layer: "base", order: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadUserLandofileAt root-aware seam", () => {
  test("resolves at an explicit root without changing the host cwd", async () => {
    const left = await realpath(await mkdtemp(join(tmpdir(), "lando-at-left-")));
    const right = await realpath(await mkdtemp(join(tmpdir(), "lando-at-right-")));
    const previous = process.cwd();
    process.chdir(left);
    try {
      let observedCwd = "";
      const service = {
        discover: Effect.map(discoveryCwd(), (cwd) => {
          observedCwd = cwd;
          return literalTestLandofile(landofile("at-root"));
        }),
      } satisfies Context.Service.Shape<typeof LandofileService>;

      const result = await Effect.runPromise(loadUserLandofileAt(service, right));

      expect(result.document.name).toBe("at-root");
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

      expect(result.document.name).toBe("here");
      expect(process.cwd()).toBe(dir);
    } finally {
      process.chdir(previous);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent resolutions at different roots each discover their own root", async () => {
    const left = await realpath(await mkdtemp(join(tmpdir(), "lando-at-left-")));
    const right = await realpath(await mkdtemp(join(tmpdir(), "lando-at-right-")));
    const host = process.cwd();
    try {
      const seen: Record<string, string> = {};
      // Each discovery yields mid-flight, so the two resolutions interleave.
      const recording = (name: string, root: string) =>
        loadUserLandofileAt(
          {
            discover: discoveryCwd().pipe(
              Effect.tap((cwd) =>
                Effect.sync(() => {
                  seen[name] = cwd;
                }),
              ),
              Effect.andThen(Effect.yieldNow),
              Effect.as(literalTestLandofile(landofile(name))),
            ),
          },
          root,
        );

      const [first, second] = await Effect.runPromise(
        Effect.all([recording("left", left), recording("right", right)], { concurrency: "unbounded" }),
      );

      expect([first.document.name, second.document.name]).toEqual(["left", "right"]);
      expect(seen).toEqual({ left, right });
      expect(process.cwd()).toBe(host);
    } finally {
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });
});
