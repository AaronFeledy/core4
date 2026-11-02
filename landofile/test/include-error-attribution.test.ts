import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { resolveAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-include-attribution-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolveFailure = (landofile: LandofileShape, maxDepth?: number) =>
  Effect.runPromise(
    Effect.flip(
      resolveAuthoredIncludes({
        landofile,
        appRoot: root,
        cacheRoot: root,
        ports: makeTestLandofilePorts(root, root),
        stateStore: makeTestLandofileStateStore(),
        ...(maxDepth === undefined ? {} : { maxDepth }),
      }),
    ),
  );

describe("include entry error attribution", () => {
  test("points a missing root include at authored index 1", async () => {
    // Given
    await writeFile(join(root, "ok.yml"), "services: {}\n");
    // When
    const error = await resolveFailure({ includes: ["./ok.yml", "./missing.yml"] });
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "fetch-failed",
      path: ["includes", 1],
      file: join(root, ".lando.yml"),
    });
  });

  test("preserves authored indices when preceding tooling entries are filtered", async () => {
    // Given
    const includes = [{ kind: "tooling", source: "./tools.yml" }, "./missing.yml"] as const;
    // When
    const error = await resolveFailure({ includes });
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileLoadError",
      failures: [
        { path: ["includes", 1], file: join(root, ".lando.yml") },
        { path: ["includes", 0], file: join(root, ".lando.yml") },
      ],
    });
  });

  test("keeps the innermost fragment's entry and physical file", async () => {
    // Given
    await writeFile(join(root, "ok.yml"), "services: {}\n");
    await writeFile(join(root, "fragment.yml"), "includes: [./ok.yml, ./missing.yml]\n");
    // When
    const error = await resolveFailure({ includes: ["./fragment.yml"] });
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      path: ["includes", 1],
      file: join(root, "fragment.yml"),
    });
  });

  test("attributes a cycle to the fragment declaring the repeated entry", async () => {
    // Given
    await writeFile(join(root, "fragment.yml"), "includes: [./fragment.yml]\n");
    // When
    const error = await resolveFailure({ includes: ["./fragment.yml"] });
    // Then
    expect(error).toMatchObject({
      kind: "cycle",
      path: ["includes", 0],
      file: join(root, "fragment.yml"),
    });
  });

  test("attributes fragment parse validation failures to the including entry", async () => {
    // Given
    await writeFile(join(root, "fragment.yml"), "name: forbidden\n");
    // When
    const error = await resolveFailure({ includes: ["./fragment.yml"] });
    // Then
    expect(error).toMatchObject({
      kind: "forbidden-field",
      path: ["includes", 0],
      file: join(root, ".lando.yml"),
    });
  });

  test("attributes user-profile remote rejection to the profile file", async () => {
    // Given
    await writeFile(join(root, "profile.yml"), "includes: [github:acme/profile/fragment.yml]\n");
    // When
    const error = await resolveFailure({ includes: ["user:profile.yml"] });
    // Then
    expect(error).toMatchObject({
      kind: "source-unresolved",
      path: ["includes", 0],
      file: join(root, "profile.yml"),
    });
  });

  test("attributes a depth failure to the entry that crosses the limit", async () => {
    // Given
    await writeFile(join(root, "a.yml"), "includes: [./b.yml]\n");
    await writeFile(join(root, "b.yml"), "services: {}\n");
    // When
    const error = await resolveFailure({ includes: ["./a.yml"] }, 1);
    // Then
    expect(error).toMatchObject({ kind: "max-depth", path: ["includes", 0], file: join(root, "a.yml") });
  });

  test("lint keeps the layer that reached a failing nested fragment", async () => {
    // Given
    await writeFile(join(root, ".lando.yml"), "name: attribution\n");
    await writeFile(join(root, ".lando.local.yml"), "includes: [./fragment.yml]\n");
    await writeFile(join(root, "fragment.yml"), "includes: [./missing.yml]\n");
    // When
    const { result } = await Effect.runPromise(
      lintLandofileSnapshot(
        { cwd: root },
        {
          ports: makeTestLandofilePorts(root),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        },
      ),
    );
    // Then
    expect(result.violations).toEqual([
      expect.objectContaining({
        rule: "landofile.load",
        path: ["includes", 0],
        source: { file: join(root, "fragment.yml"), layer: "local", path: ["includes", 0] },
      }),
    ]);
  });

  for (const nested of [false, true]) {
    test(`lint reports the ${nested ? "fragment" : "root"} include entry location`, async () => {
      // Given
      await writeFile(join(root, "ok.yml"), "services: {}\n");
      await writeFile(
        join(root, ".lando.yml"),
        `name: attribution\nincludes: ${nested ? "[./fragment.yml]" : "[./ok.yml, ./missing.yml]"}\n`,
      );
      if (nested) await writeFile(join(root, "fragment.yml"), "includes: [./ok.yml, ./missing.yml]\n");
      // When
      const { result } = await Effect.runPromise(
        lintLandofileSnapshot(
          { cwd: root },
          {
            ports: makeTestLandofilePorts(root),
            stateStore: makeTestLandofileStateStore(),
            templates: { modules: [] },
          },
        ),
      );
      // Then
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.load",
          path: ["includes", 1],
          source: {
            file: join(root, nested ? "fragment.yml" : ".lando.yml"),
            layer: "canonical",
            path: ["includes", 1],
          },
        }),
      ]);
    });
  }
});
