import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigTranslateDocument } from "@lando/sdk/schema";
import { ConfigTranslateSourceId, PortablePath } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";
import {
  buildDocumentSetShape,
  layerForSourcePath,
  lowerV4LayerFragments,
  orderSourcePaths,
} from "../../src/cli/commands/app-config-translate-document-set.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeAppDir = async (files: Readonly<Record<string, string>>) => {
  const dir = await mkdtemp(join(tmpdir(), "lando-translate-docset-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(dir, path), content);
  return dir;
};

const failureValue = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;

const yamlDocument = (path: string, content: string): ConfigTranslateDocument => {
  const bytes = new TextEncoder().encode(content);
  return {
    sourceId: ConfigTranslateSourceId.make(path),
    layerId: layerForSourcePath(path),
    path: PortablePath.make(path),
    mediaType: "application/yaml",
    contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
    bytes,
  };
};

describe("translate document set", () => {
  test("assigns declared layers by basename and canonical to foreign files", () => {
    // Given
    const paths = [
      ".lando.yml",
      ".lando.local.yml",
      ".lando.local.yaml",
      ".lando.base.yml",
      ".lando.user.yml",
      "docker-compose.yml",
      "sub/dir/.lando.dist.yml",
    ];
    // When
    const layers = paths.map(layerForSourcePath);
    // Then
    expect(layers).toEqual(["canonical", "local", "local", "base", "user", "canonical", "dist"]);
  });

  test("orders documents by layer position then path", () => {
    // Given
    const paths = [".lando.local.yml", "docker-compose.yml", ".lando.base.yml", ".lando.yml"].map((path) =>
      PortablePath.make(path),
    );
    const original = [...paths];
    // When
    const ordered = orderSourcePaths(paths);
    // Then
    expect(ordered).toEqual(
      [".lando.base.yml", ".lando.yml", "docker-compose.yml", ".lando.local.yml"].map((path) =>
        PortablePath.make(path),
      ),
    );
    expect(paths).toEqual(original);
  });

  test.each([{ selected: undefined }, { selected: [] }])(
    "full mode exposes every declared layer",
    ({ selected }) => {
      // Given / When
      const shape = buildDocumentSetShape({ sourceIds: [".lando.yml"], selected });
      // Then
      expect(shape).toEqual({
        mode: "full",
        selectedSourceIds: [".lando.yml"],
        writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
      });
    },
  );

  test("single-layer selection narrows writable layers to the selected closure", () => {
    // Given / When
    const shape = buildDocumentSetShape({
      sourceIds: [".lando.yml", ".lando.local.yml"],
      selected: [".lando.local.yml"],
    });
    // Then
    expect(shape).toEqual({
      mode: "single-layer",
      selectedSourceIds: [".lando.local.yml"],
      writableLayerIds: ["local"],
    });
  });

  test("deduplicates selected layers in position order", () => {
    // Given
    const selected = [".lando.user.yml", "foreign.yml", ".lando.base.yml", ".lando.yml"];
    // When
    const shape = buildDocumentSetShape({ sourceIds: selected, selected });
    // Then
    expect(shape.writableLayerIds).toEqual(["base", "canonical", "user"]);
    expect(shape.selectedSourceIds).toEqual(selected);
    expect(shape.selectedSourceIds).not.toBe(selected);
  });

  test("parses present lower layers below the selected layer as v4 fragments", async () => {
    // Given
    const appRoot = await makeAppDir({ ".lando.base.yml": "name: demo\n", ".lando.yml": "runtime: 4\n" });
    // When
    const fragments = await Effect.runPromise(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [".lando.local.yml"],
        documents: [
          yamlDocument(".lando.base.yml", "name: demo\n"),
          yamlDocument(".lando.yml", "runtime: 4\n"),
        ],
      }),
    );
    // Then
    expect(fragments).toEqual([
      { layerId: "base", fragment: { name: "demo" } },
      { layerId: "canonical", fragment: { runtime: 4 } },
    ]);
  });

  test("ignores present layers at or above the selected layer", async () => {
    // Given
    const appRoot = await makeAppDir({
      ".lando.local.yml": "recipe: lamp\n",
      ".lando.user.yml": "recipe: lamp\n",
    });
    // When
    const fragments = await Effect.runPromise(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [".lando.local.yml"],
        documents: [
          yamlDocument(".lando.local.yml", "recipe: lamp\n"),
          yamlDocument(".lando.user.yml", "recipe: lamp\n"),
        ],
      }),
    );
    // Then
    expect(fragments).toEqual([]);
  });

  test.each(['recipe: lamp\nconfig:\n  php: "7.4"\n', "runtime: [\n"])(
    "fails closed naming a lower layer that is not valid v4",
    async (content) => {
      // Given
      const appRoot = await makeAppDir({ ".lando.yml": content });
      // When
      const exit = await Effect.runPromiseExit(
        lowerV4LayerFragments({
          appRoot,
          selectedSourceIds: [".lando.local.yml"],
          documents: [yamlDocument(".lando.yml", content)],
        }),
      );
      // Then
      const failure = failureValue(exit);
      expect(failure?._tag).toBe("ConfigTranslateError");
      expect(failure?.message).toContain(".lando.yml is not a v4 Landofile fragment");
      expect(failure?.remediation).toContain("--file .lando.yml");
    },
  );

  test("surfaces a Landofile form conflict unchanged", async () => {
    // Given
    const appRoot = await makeAppDir({ ".lando.yml": "runtime: 4\n", ".lando.ts": "export default {};" });
    // When
    const exit = await Effect.runPromiseExit(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [".lando.local.yml"],
        documents: [yamlDocument(".lando.yml", "runtime: 4\n")],
      }),
    );
    // Then
    expect(failureValue(exit)).toMatchObject({
      _tag: "LandofileFormConflictError",
      layer: "canonical",
      yamlPath: join(appRoot, ".lando.yml"),
      typescriptPath: join(appRoot, ".lando.ts"),
    });
  });

  test("rejects opaque TypeScript without executing it", async () => {
    // Given
    const appRoot = await makeAppDir({
      ".lando.ts":
        'await Bun.write(new URL("./executed", import.meta.url), "executed"); export default { runtime: 4 };',
    });
    // When
    const exit = await Effect.runPromiseExit(
      lowerV4LayerFragments({ appRoot, selectedSourceIds: [".lando.local.yml"], documents: [] }),
    );
    // Then
    expect(failureValue(exit)?._tag).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.message).toContain(".lando.ts is not a v4 Landofile fragment");
    expect(failureValue(exit)?.remediation).toContain(".lando.ts");
    expect(await Bun.file(join(appRoot, "executed")).exists()).toBe(false);
  });

  test("excludes selected lower sources from context", async () => {
    // Given
    const appRoot = await makeAppDir({ ".lando.base.yml": "name: demo\n", ".lando.yml": "recipe: lamp\n" });
    // When
    const fragments = await Effect.runPromise(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [".lando.yml", ".lando.local.yml"],
        documents: [
          yamlDocument(".lando.base.yml", "name: demo\n"),
          yamlDocument(".lando.yml", "recipe: lamp\n"),
        ],
      }),
    );
    // Then
    expect(fragments).toEqual([{ layerId: "base", fragment: { name: "demo" } }]);
  });

  test("returns no context for an empty selection", async () => {
    // Given
    const appRoot = await makeAppDir({ ".lando.yml": "recipe: lamp\n" });
    // When
    const fragments = await Effect.runPromise(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [],
        documents: [yamlDocument(".lando.yml", "recipe: lamp\n")],
      }),
    );
    // Then
    expect(fragments).toEqual([]);
  });

  test("uses bounded snapshots instead of rereading lower YAML", async () => {
    // Given: disk bytes are not valid v4, but the snapshot is.
    const appRoot = await makeAppDir({ ".lando.yml": "recipe: lamp\n" });
    // When
    const fragments = await Effect.runPromise(
      lowerV4LayerFragments({
        appRoot,
        selectedSourceIds: [".lando.local.yml"],
        documents: [yamlDocument(".lando.yml", "name: demo\nruntime: 4\n")],
      }),
    );
    // Then
    expect(fragments).toEqual([{ layerId: "canonical", fragment: { name: "demo", runtime: 4 } }]);
  });

  test("fails closed when a present lower YAML has no snapshot", async () => {
    // Given
    const appRoot = await makeAppDir({ ".lando.yml": "name: demo\nruntime: 4\n" });
    // When
    const exit = await Effect.runPromiseExit(
      lowerV4LayerFragments({ appRoot, selectedSourceIds: [".lando.local.yml"], documents: [] }),
    );
    // Then
    expect(failureValue(exit)?._tag).toBe("ConfigTranslateError");
    expect(failureValue(exit)?.message).toContain(".lando.yml");
  });
});
