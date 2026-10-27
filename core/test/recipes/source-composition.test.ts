import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveRecipeSource } from "../../src/recipes/resolved-source";
import { resolveRecipeRef } from "../../src/recipes/source";

const withSources = async (run: (root: string) => Promise<void>, drops = false) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-composition-")));
  try {
    await mkdir(join(root, "parent"));
    await mkdir(join(root, "child"));
    await Bun.write(
      join(root, "parent", "recipe.yml"),
      `id: parent
title: Parent
description: Parent source
version: 1.0.0
options:
  enabled:
    type:
      kind: boolean
    default: true
  removed:
    type:
      kind: string
    default: old
config:
  services:
    web:
      image: parent:1
variants:
  - when: options.enabled
    config:
      services:
        web:
          image: parent:2
files:
  - src: asset.bin
    dest: inherited.bin
  - src: asset.bin
    dest: replaced.bin
  - src: asset.bin
    dest: removed.bin
postInit:
  - type: bun
    verb: script
    script: setup.bun.sh
`,
    );
    await Bun.write(
      join(root, "child", "recipe.yml"),
      `id: child
title: Child
description: Child source
version: 2.0.0
extends: ../parent
options:
  enabled:
    type:
      kind: boolean
    default: false
${drops ? "  removed:\n    drop: true\n" : ""}
config:
  services:
    web:
      ports:
        - 8080
variants:
  - when: options.enabled
    config:
      services:
        web:
          image: child:3
files:
  - src: asset.bin
    dest: replaced.bin
${drops ? "  - dest: removed.bin\n    drop: true\n" : ""}
postInit:
  - type: message
    text: finished
`,
    );
    await Bun.write(join(root, "parent", "asset.bin"), new Uint8Array([0, 255, 1]));
    await Bun.write(join(root, "child", "asset.bin"), "shadow");
    await Bun.write(join(root, "parent", "setup.bun.sh"), "parent-script");
    await Bun.write(join(root, "child", "setup.bun.sh"), "shadow-script");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const resolveChild = (root: string) =>
  Effect.runPromise(resolveRecipeRef("./child", { cwd: root }).pipe(Effect.flatMap(resolveRecipeSource)));

test("preserves declaring assets and scripts when the resolved carrier is cloned", async () => {
  await withSources(async (root) => {
    const resolved = await resolveChild(root);
    const copied = structuredClone(resolved);
    const inherited = copied.files.find(({ value }) => value.dest === "inherited.bin");
    const script = copied.postInit[0];
    expect(inherited?.origin).toEqual({ kind: "directory", root: join(root, "parent") });
    if (inherited?.origin.kind !== "directory" || script?.origin.kind !== "directory")
      throw new Error("Expected directory declarations");
    expect(
      new Uint8Array(await Bun.file(join(inherited.origin.root, inherited.value.src)).arrayBuffer()),
    ).toEqual(new Uint8Array([0, 255, 1]));
    expect(await Bun.file(join(script.origin.root, "setup.bun.sh")).text()).toBe("parent-script");
    expect(copied.files.find(({ value }) => value.dest === "replaced.bin")?.origin).toEqual({
      kind: "directory",
      root: join(root, "child"),
    });
  });
});

test("keeps parent base and variants before child layers when composing overrides and drops", async () => {
  await withSources(async (root) => {
    const composed = await resolveChild(root);
    expect(composed.sources.map(({ value }) => value.id)).toEqual(["parent", "child"]);
    expect(composed.source.id).toBe("child");
    expect(composed.source.options).toEqual({ enabled: { type: { kind: "boolean" }, default: false } });
    expect(composed.files.map(({ value }) => value.dest)).toEqual(["inherited.bin", "replaced.bin"]);
    expect(composed.postInit.map(({ value }) => value.type)).toEqual(["bun", "message"]);
    expect(composed.configLayers).toEqual([
      { config: { services: { web: { image: "parent:1" } } } },
      { when: "options.enabled", config: { services: { web: { image: "parent:2" } } } },
      { config: { services: { web: { ports: [8080] } } } },
      { when: "options.enabled", config: { services: { web: { image: "child:3" } } } },
    ]);
  }, true);
});

test("changes parent evidence when an ancestor source changes", async () => {
  await withSources(async (root) => {
    const before = await resolveChild(root);
    const path = join(root, "parent", "recipe.yml");
    await Bun.write(path, (await Bun.file(path).text()).replace("parent:1", "parent:9"));
    const after = await resolveChild(root);
    expect(after.sources[0]?.evidence.contentDigest).not.toBe(before.sources[0]?.evidence.contentDigest);
    expect(after.sources[1]?.evidence.contentDigest).toBe(before.sources[1]?.evidence.contentDigest);
    expect(JSON.stringify(after.sources.map(({ evidence }) => evidence))).not.toContain(root);
  });
});

test("keeps portable source evidence stable when a local parent coordinate becomes absolute", async () => {
  await withSources(async (root) => {
    const before = await resolveChild(root);
    const path = join(root, "child/recipe.yml");
    await Bun.write(path, (await Bun.file(path).text()).replace("../parent", join(root, "parent")));
    const after = await resolveChild(root);
    expect(after.sources.map(({ evidence }) => evidence.contentDigest)).toEqual(
      before.sources.map(({ evidence }) => evidence.contentDigest),
    );
    expect(after.sources[1]?.evidence.rawDigest).not.toBe(before.sources[1]?.evidence.rawDigest);
  });
});

test("preserves an own __proto__ option through TypeScript inheritance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-own-option-")));
  try {
    for (const id of ["parent", "child"]) {
      await mkdir(join(root, id));
      await Bun.write(
        join(root, id, "recipe.ts"),
        `export default {
          id: "${id}", title: "Example", description: "Example", version: "1.0.0",
          ${id === "child" ? 'extends: "../parent",' : ""}
          options: { ["__proto__"]: { type: { kind: "string" }, default: "${id}" } },
          config: {}
        };`,
      );
    }
    const resolved = await resolveChild(root);
    expect(Object.hasOwn(resolved.source.options ?? {}, "__proto__")).toBe(true);
    expect(resolved.source.options?.__proto__).toEqual({ type: { kind: "string" }, default: "child" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
