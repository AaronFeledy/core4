import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";
import { makeArchiveTransportForBytes, withRecipeSources } from "../_support/recipe-source-session.ts";
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

test("git authored recipe initializes from an explicitly selected subpath", async () => {
  const { root, manifest, options } = await fixture();
  const yaml = externalRecipeYaml(manifest);
  await withRecipeSources(
    {
      root: join(root, "sources"),
      git: {
        fetch: async ({ dest }) => {
          await Bun.write(join(dest, "recipes/external/recipe.yml"), yaml);
          return { commit: "a".repeat(40) };
        },
      },
    },
    async ({ session, store }) => {
      const result = await initApp({
        ...options,
        source: "git",
        path: "recipes/external",
        url: "https://example.test/r.git",
        sources: session,
        recipeSourceStore: store,
      });
      expect(result.appName).toBe("snapshot-app");
      expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
    },
  );
});

test("tarball authored recipe initializes from an explicitly selected subpath", async () => {
  const { root, manifest, options } = await fixture();
  const yaml = externalRecipeYaml(manifest);
  // Build a real tarball with host tar
  const stage = join(root, "tar-build");
  await mkdir(join(stage, "recipes/external"), { recursive: true });
  await Bun.write(join(stage, "recipes/external/recipe.yml"), yaml);
  const out = join(root, "recipe.tgz");
  const proc = Bun.spawn({ cmd: ["tar", "-czf", out, "-C", stage, "."], stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  const checksum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await withRecipeSources(
    {
      root: join(root, "sources"),
      archive: makeArchiveTransportForBytes(bytes),
    },
    async ({ session, store }) => {
      const result = await initApp({
        ...options,
        source: "tarball",
        path: "recipes/external",
        url: "https://example.test/recipe.tgz",
        checksum,
        sources: session,
        recipeSourceStore: store,
      });
      expect(result.appName).toBe("snapshot-app");
      expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
    },
  );
});
