import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOOTSTRAP_RANK } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedLayersDir = resolve(repoRoot, "core/src/runtime/generated/layers");
const runtimeLayerPath = resolve(repoRoot, "core/src/runtime/layer.ts");

describe("generated bootstrap layers", () => {
  test("commits one generated module for every BootstrapLevel", async () => {
    const files = await readdir(generatedLayersDir);
    const expected = [...Object.keys(BOOTSTRAP_RANK).map((level) => `${level}.ts`), "index.ts"].sort();

    expect(files.toSorted()).toEqual(expected);
  });

  test("runtime layer factory consumes generated bootstrap composition", async () => {
    const source = await readFile(runtimeLayerPath, "utf8");

    expect(source).toContain("./generated/layers/index.ts");
    expect(source).not.toContain("Layer.mergeAll(");
    expect(source).not.toContain("Layer.provide(");
  });
});
