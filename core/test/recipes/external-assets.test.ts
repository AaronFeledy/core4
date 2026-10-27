import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";
import { externalRecipeSource, externalRecipeYaml } from "./fixtures/external-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-assets-")));
  roots.push(root);
  return {
    root,
    options: {
      cwd: root,
      full: false,
      name: "external-app",
      destination: join(root, "app"),
      nonInteractive: true,
      runPostInit: false,
      userDataRoot: join(root, "data"),
    },
  };
};

test("external recipe sharing a bundled id uses its own compiled source and assets", async () => {
  // Given
  const { root, options } = await fixture();
  const recipe = join(root, "node-postgres");
  const raw = new Uint8Array([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47]);
  await Bun.write(join(recipe, "payload.bin"), raw);
  await Bun.write(
    join(recipe, "recipe.yml"),
    externalRecipeYaml(
      externalRecipeSource({ id: "node-postgres", files: [{ src: "payload.bin", dest: "package.json" }] }),
    ),
  );
  // When
  const result = await initApp({ ...options, recipe });
  // Then
  expect(await Bun.file(join(result.directory, "package.json")).bytes()).toEqual(raw);
  expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
});

test("asset acquisition is checked before an occupied scaffold is filtered", async () => {
  // Given
  const { root, options } = await fixture();
  const recipe = join(root, "external");
  await Bun.write(
    join(recipe, "recipe.yml"),
    externalRecipeYaml(externalRecipeSource({ files: [{ src: "missing", dest: "notice" }] })),
  );
  await Bun.write(join(options.destination, "notice"), "existing");
  // When / Then
  await expect(initApp({ ...options, recipe })).rejects.toMatchObject({
    _tag: "RecipeManifestValidationError",
  });
  expect(await readdir(options.destination)).toEqual(["notice"]);
});

test("author-supplied asset digest assertions are rejected before the Landofile commit", async () => {
  // Given
  const { root, options } = await fixture();
  const recipe = join(root, "external");
  await Bun.write(
    join(recipe, "recipe.yml"),
    `${externalRecipeYaml(externalRecipeSource())}snapshot:\n  assets:\n    - dest: notice\n      digest: sha256:${"0".repeat(64)}\n`,
  );
  // When / Then
  await expect(initApp({ ...options, recipe })).rejects.toMatchObject({
    _tag: "RecipeManifestValidationError",
  });
  expect(await Bun.file(join(options.destination, ".lando.yml")).exists()).toBe(false);
});

test("normalized duplicate destinations fail before any scaffold write", async () => {
  // Given
  const { root, options } = await fixture();
  const recipe = join(root, "external");
  await Bun.write(
    join(recipe, "recipe.yml"),
    externalRecipeYaml(
      externalRecipeSource({
        files: [
          { src: "asset", dest: "notice" },
          { src: "asset", dest: "./notice" },
        ],
      }),
    ),
  );
  await Bun.write(join(recipe, "asset"), "bytes");
  // When / Then
  await expect(initApp({ ...options, recipe })).rejects.toMatchObject({
    _tag: "RecipeInitBlockedError",
    stage: "validate",
  });
  expect(await Bun.file(join(options.destination, ".lando.yml")).exists()).toBe(false);
});

test("raw secret bytes in an auxiliary asset block the Landofile commit", async () => {
  // Given
  const { root, options } = await fixture();
  const recipe = join(root, "external");
  const token = "päss🔐";
  await Bun.write(
    join(recipe, "recipe.yml"),
    externalRecipeYaml(
      externalRecipeSource({
        files: [{ src: "asset", dest: "notice" }],
        options: {
          token: {
            type: { kind: "secret" },
            disposition: { kind: "init-only", sink: { kind: "secretEnv", name: "AUTH" } },
          },
        },
        postInit: [{ type: "bun", verb: "run", script: "setup", secretEnv: { AUTH: "token" } }],
      }),
    ),
  );
  await Bun.write(join(recipe, "asset"), new Uint8Array([0xff, ...new TextEncoder().encode(token), 0xfe]));
  // When / Then
  await expect(initApp({ ...options, recipe, answers: { token } })).rejects.toMatchObject({
    _tag: "RecipeInitBlockedError",
    stage: "validate",
  });
  expect(await Bun.file(join(options.destination, ".lando.yml")).exists()).toBe(false);
});
