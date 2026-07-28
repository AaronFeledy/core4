import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createModuleEdgeCache } from "../../../../scripts/architecture/edges.ts";
import { createInventory } from "../../../../scripts/architecture/inventory.ts";
import { createSourceFileCache } from "../../../../scripts/architecture/parse.ts";

let root: string;

const write = async (path: string, contents = "export const value = 1;\n"): Promise<void> => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "architecture-inventory-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("architecture inventory", () => {
  test("returns sorted core and plugin TypeScript production sources", async () => {
    // Given
    await Promise.all([
      write("core/src/z.ts"),
      write("core/src/a.test.ts"),
      write("plugins/example/src/index.ts"),
      write("plugins/example/tools/build.ts"),
      write("plugins/example/src/view.tsx"),
      write("sdk/src/index.ts"),
    ]);

    // When
    const files = await createInventory(root).files("core-and-plugin-sources");

    // Then
    expect(files.map(({ relativePath }) => relativePath)).toEqual([
      "core/src/z.ts",
      "plugins/example/src/index.ts",
      "plugins/example/tools/build.ts",
    ]);
  });

  test("returns only service-lando service production sources", async () => {
    // Given
    await Promise.all([
      write("plugins/service-lando/src/services/a.ts"),
      write("plugins/service-lando/src/services/a.test.ts"),
      write("plugins/service-lando/src/other.ts"),
      write("plugins/example/src/services/a.ts"),
    ]);

    // When
    const files = await createInventory(root).files("service-lando-services");

    // Then
    expect(files.map(({ relativePath }) => relativePath)).toEqual([
      "plugins/service-lando/src/services/a.ts",
    ]);
  });

  test("returns runtime sources for every workspace package", async () => {
    // Given
    await Promise.all([
      write("core/src/index.ts"),
      write("sdk/src/index.tsx"),
      write("container-runtime/src/index.mts"),
      write("plugins/example/src/index.cts"),
      write("plugins/example/src/index.test.tsx"),
      write("plugins/example/tools/build.ts"),
    ]);

    // When
    const files = await createInventory(root).files("workspace-runtime-sources");

    // Then
    expect(files.map(({ relativePath }) => relativePath)).toEqual([
      "container-runtime/src/index.mts",
      "core/src/index.ts",
      "plugins/example/src/index.cts",
      "sdk/src/index.tsx",
    ]);
  });

  test("returns an empty inventory when source roots are missing", async () => {
    // Given
    const missingRoot = join(root, "missing");

    // When
    const files = await createInventory(missingRoot).files("workspace-runtime-sources");

    // Then
    expect(files).toEqual([]);
  });

  test("memoizes selector results and emits posix relative paths", async () => {
    // Given
    await write("core/src/nested/index.ts");
    const inventory = createInventory(root);

    // When
    const first = await inventory.files("core-and-plugin-sources");
    const second = await inventory.files("core-and-plugin-sources");

    // Then
    expect(second).toBe(first);
    expect(first[0]?.relativePath).toBe("core/src/nested/index.ts");
    expect(first[0]?.relativePath).not.toContain("\\");
  });
});

describe("architecture source caches", () => {
  test("returns the same parsed source object for a repeated absolute path", () => {
    // Given
    const cache = createSourceFileCache();
    const file = join(root, "core/src/index.ts");

    // When
    const first = cache.sourceFile(file, "export const value = 1;\n");
    const second = cache.sourceFile(file, "export const value = 1;\n");

    // Then
    expect(second).toBe(first);
  });

  test("returns the same module-edge array for a repeated absolute path", () => {
    // Given
    const cache = createModuleEdgeCache();
    const file = join(root, "core/src/index.ts");
    const source = 'import { value } from "./value.ts";\n';

    // When
    const first = cache.moduleEdges(file, source);
    const second = cache.moduleEdges(file, source);

    // Then
    expect(second).toBe(first);
    expect(first).toHaveLength(1);
  });
});
