import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { HUGO_BUILD_ARTIFACT } from "../../src/recipes/builtin/hugo/install.ts";
import { HUGO_SCAFFOLD } from "../../src/recipes/builtin/hugo/scaffold.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "hugo-init-"));
  const journalRoot = await mkdtemp(join(tmpdir(), "hugo-init-journal-"));
  roots.push(appRoot, journalRoot);
  return {
    cwd: appRoot,
    destination: appRoot,
    userDataRoot: journalRoot,
    name: "hugo-probe",
    recipe: "hugo",
    full: false,
    nonInteractive: true,
    runPostInit: false,
  };
};

test("init writes a complete theme-free Hugo site beside the Landofile", async () => {
  // Given an empty destination and the real bundled manifest/encoder.
  const request = await fixture();

  // When the public init pipeline commits the recipe.
  const result = await initApp(request);

  // Then all site files exist, and the Landofile uses image-baked Hugo directly.
  expect(Object.keys(HUGO_SCAFFOLD)).toEqual([
    "hugo.toml",
    "archetypes/default.md",
    "content/_index.md",
    "layouts/baseof.html",
    "layouts/home.html",
    "layouts/single.html",
    "layouts/list.html",
  ]);
  for (const [dest, content] of Object.entries(HUGO_SCAFFOLD)) {
    expect(await Bun.file(join(result.directory, dest)).text()).toBe(
      content.replaceAll("{{ app.name }}", "hugo-probe"),
    );
  }
  const output = Bun.YAML.parse(await Bun.file(join(result.directory, ".lando.yml")).text());
  const { services } = Schema.decodeUnknownSync(
    Schema.Struct({
      services: Schema.Struct({
        builder: Schema.Struct({ build: Schema.Struct({ artifact: Schema.Array(Schema.String) }) }),
      }),
    }),
  )(output);
  for (const command of services.builder.build.artifact) {
    expect(Array.from(command).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).toBe(
      false,
    );
  }
  expect(output).toMatchObject({
    services: {
      builder: {
        build: { artifact: [...HUGO_BUILD_ARTIFACT] },
        command: "hugo server --bind 0.0.0.0 --port 1313",
      },
    },
    tooling: { hugo: { cmds: ["hugo"] }, npm: { cmds: ["npm"] } },
  });
});

test("init coexists with existing Hugo and npm files without replacing them", async () => {
  // Given an existing site without a Landofile.
  const request = await fixture();
  const existing = {
    "hugo.toml": "title = 'Existing site'\n",
    "layouts/single.html": "<article>{{ .Content }}</article>\n",
    "content/posts/first.md": "+++\ntitle = 'First'\n+++\nExisting content\n",
    "package.json": '{"private":true}\n',
  };
  for (const [dest, content] of Object.entries(existing))
    await Bun.write(join(request.destination, dest), content);

  // When public init plans writes beside the existing site.
  const result = await initApp(request);

  // Then existing bytes survive and the whole auxiliary scaffold is withheld.
  for (const [dest, content] of Object.entries(existing)) {
    expect(await Bun.file(join(result.directory, dest)).text()).toBe(content);
  }
  expect(result.skippedScaffold).toEqual(Object.keys(HUGO_SCAFFOLD));
  expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);
  expect(await Bun.file(join(result.directory, "layouts/home.html")).exists()).toBe(false);
});

test("init refuses an existing Landofile before writing site assets", async () => {
  // Given an app that already owns its Landofile and content.
  const request = await fixture();
  await Bun.write(join(request.destination, ".lando.yml"), "name: existing\nruntime: 4\n");
  await Bun.write(join(request.destination, "content/posts/first.md"), "Existing content\n");

  // When init attempts to commit into the existing app.
  const result = initApp(request);

  // Then the transaction refuses, preserving the app and writing no scaffold.
  expect(result).rejects.toMatchObject({ _tag: "InitTargetExistsError" });
  expect(await Bun.file(join(request.destination, ".lando.yml")).text()).toBe("name: existing\nruntime: 4\n");
  expect(await Bun.file(join(request.destination, "content/posts/first.md")).text()).toBe(
    "Existing content\n",
  );
  for (const dest of Object.keys(HUGO_SCAFFOLD)) {
    expect(await Bun.file(join(request.destination, dest)).exists()).toBe(false);
  }
});
