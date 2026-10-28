import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InitTargetExistsError } from "@lando/sdk/errors";
import type { InitAppOptions } from "../../src/cli/commands/init.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";
import { externalRecipeSource, externalRecipeYaml } from "./fixtures/external-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-init-")));
  roots.push(root);
  const manifest = externalRecipeSource();
  const recipe = join(root, "external");
  await Bun.write(join(recipe, "recipe.yml"), externalRecipeYaml(manifest));
  return {
    root,
    recipe,
    manifest,
    options: {
      cwd: root,
      full: false,
      name: "snapshot-app",
      destination: join(root, "app"),
      nonInteractive: true,
      runPostInit: false,
      userDataRoot: join(root, "data"),
    },
  };
};

test("local authored YAML initializes through the public CLI", async () => {
  // Given
  const { root, recipe, options } = await fixture();
  const entry = resolve(import.meta.dirname, "../../bin/lando.ts");
  // When
  const child = Bun.spawn(
    [
      process.execPath,
      entry,
      "init",
      options.destination,
      `--recipe=${recipe}`,
      "--name=snapshot-app",
      "--no-interactive",
      "--format=json",
    ],
    {
      cwd: root,
      env: { ...process.env, LANDO_USER_DATA_ROOT: options.userDataRoot },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // Then
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout).ok).toBe(true);
  expect(await Bun.file(join(options.destination, ".lando.yml")).text()).toContain("alpine:3.21");
});

test("local recipe.ts source initializes without a YAML source", async () => {
  // Given
  const { recipe, manifest, options } = await fixture();
  await rm(join(recipe, "recipe.yml"));
  await Bun.write(join(recipe, "recipe.ts"), `export default ${JSON.stringify(manifest)};`);
  // When
  const result = await initApp({ ...options, recipe });
  // Then
  expect(result.appName).toBe("snapshot-app");
  expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
});

for (const source of ["git", "tarball", "npm", "registry"] as const) {
  test(`${source} authored recipe initializes from an explicitly selected subpath`, async () => {
    // Given
    const { manifest, options } = await fixture();
    const yaml = externalRecipeYaml(manifest);
    const bytes = new TextEncoder().encode("transport fixture");
    const transport: Partial<InitAppOptions> = {
      source,
      path: "recipes/external",
      url: "https://example.test/recipe.tgz",
      package: "@test/external",
      id: "external",
      checksum: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      gitRecipeCloner: {
        clone: async ({ stagingDir }) => {
          await Bun.write(join(stagingDir, "recipes/external/recipe.yml"), yaml);
          return { commitSha: "a".repeat(40) };
        },
      },
      tarballRecipeFetcher: { fetch: async () => bytes },
      tarballRecipeExtractor: {
        extract: async (_bytes, stagingDir) => {
          await Bun.write(
            join(
              stagingDir,
              source === "npm" ? "package/recipes/external/recipe.yml" : "recipes/external/recipe.yml",
            ),
            yaml,
          );
        },
      },
      npmRegistryClient: {
        fetchPackument: async () => ({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: {
                tarball: "https://example.test/recipe.tgz",
                integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`,
              },
            },
          },
        }),
      },
      registryClient: {
        fetchResolution: async () => ({
          id: "external",
          resolution: { kind: "git", url: "https://example.test/recipe.git" },
        }),
      },
    };
    // When
    const result = await initApp({ ...options, ...transport });
    // Then
    expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
  });
}

test("missing child authored config is tagged before creating a scaffold", async () => {
  // Given
  const { recipe, options } = await fixture();
  await Bun.write(
    join(recipe, "recipe.yml"),
    "id: external\ntitle: External\ndescription: Missing child snapshot\nversion: 1.0.0\nextends: toolbox\n",
  );
  // When / Then
  await expect(initApp({ ...options, recipe })).rejects.toMatchObject({
    _tag: "RecipeManifestValidationError",
  });
  expect(await Bun.file(join(options.destination, ".lando.yml")).exists()).toBe(false);
});

for (const occupied of ["directory", "dangling-link"] as const) {
  test(`existing Landofile ${occupied} is occupied`, async () => {
    // Given
    const { recipe, options } = await fixture();
    await mkdir(options.destination);
    const target = join(options.destination, ".lando.ts");
    if (occupied === "directory") await mkdir(target);
    else await symlink(join(options.destination, "missing"), target);
    // When / Then
    await expect(initApp({ ...options, recipe })).rejects.toBeInstanceOf(InitTargetExistsError);
    expect(await readdir(options.destination)).toEqual([".lando.ts"]);
  });
}
