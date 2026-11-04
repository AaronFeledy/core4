import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const entry = resolve(import.meta.dirname, "../../bin/lando.ts");
const run = async (args: readonly string[], cwd: string) => {
  const child = Bun.spawn([process.execPath, entry, ...args, "--format=json"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(cwd, "data"),
      LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
      LANDO_PROVIDER: "recipe-qa-must-not-contact",
    },
  });
  const [code, text, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, envelope: JSON.parse(text), stderr };
};
const fixture = async (tail = "") => {
  const root = await mkdtemp(join(tmpdir(), "recipe-readiness-"));
  roots.push(root);
  const source = join(root, "small");
  await mkdir(source);
  const yaml = `id: small\ntitle: Small\ndescription: Authored source\nversion: 1.0.0\nconfig:\n  runtime: 4\n  services:\n    app:\n      type: lando\n      image: alpine:3.21\n${tail}`;
  await Bun.write(join(source, "recipe.yml"), yaml);
  return { root, source, yaml };
};

test("validate describe and init agree on required input and typed false defaults", async () => {
  // Given
  const f = await fixture(
    "options:\n  required:\n    type:\n      kind: string\n  enabled:\n    type:\n      kind: boolean\n    default: false\n",
  );
  // When
  const validation = await run(["meta", "recipes", "validate", f.source], f.root);
  const description = await run(["meta", "recipes", "describe", f.source], f.root);
  const missing = await run(["init", `--recipe=${f.source}`, "--no-interactive", "--name=small-app"], f.root);
  const initialization = await run(
    ["init", `--recipe=${f.source}`, "--no-interactive", "--name=small-app", "--answer=required=answer"],
    f.root,
  );
  // Then
  expect(validation.code).toBe(0);
  expect(description.code).toBe(0);
  for (const result of [validation, description])
    expect(result.envelope.result).toMatchObject({
      initializable: true,
      readiness: "requires-input",
      missingAnswers: ["required"],
      historyEligible: true,
    });
  expect(missing.code).toBe(1);
  expect(missing.envelope.error._tag).toBe("InteractionRequiredError");
  expect(initialization.code).toBe(0);
  expect(initialization.envelope.result.answers).toMatchObject({ required: "answer", enabled: false });
  expect(initialization.envelope.result.receipt.created.map((file: { path: string }) => file.path)).toEqual([
    ".lando.yml",
  ]);
});

test.each([
  "files:\n  - src: absent\n    dest: absent\n",
  "files:\n  - src: asset\n    dest: copied\n    when: options.enabled\n",
  "files:\n  - src: asset\n    dest: copied\n    engine: handlebars\n",
  "options:\n  invalid:\n    type:\n      kind: boolean\n    default: not-a-boolean\n",
  "prompts:\n  - name: obsolete\n    type: text\n    message: Retired author field\n",
  "snapshot:\n  version: 1\n",
])(
  "inspection and init reject unsupported or invalid sources before output publication (%s)",
  async (tail) => {
    // Given
    const f = await fixture(tail);
    await Bun.write(join(f.source, "asset"), "bytes");
    // When
    const results = await Promise.all([
      run(["meta", "recipes", "validate", f.source], f.root),
      run(["meta", "recipes", "describe", f.source], f.root),
      run(["init", `--recipe=${f.source}`, "--no-interactive", "--name=blocked"], f.root),
    ]);
    // Then
    expect(results.map(({ code }) => code)).toEqual([1, 1, 1]);
    expect(results.every(({ envelope }) => envelope.ok === false)).toBe(true);
    expect(await readdir(f.root)).not.toContain("blocked");
  },
);

test("static and factory TypeScript inspect as ineligible for history and initialize with the same compiler", async () => {
  // Given
  const f = await fixture();
  await rm(join(f.source, "recipe.yml"));
  await Bun.write(
    join(f.source, "recipe.ts"),
    `import { defineRecipe } from "@lando/sdk/schema";
let calls = 0;
export default defineRecipe(() => ({ id: "small", title: "Small", description: "Factory", version: "1.0.0", config: { runtime: 4, services: { app: { type: "lando", image: "alpine:" + ++calls } } } }));`,
  );
  // When
  const validation = await run(["meta", "recipes", "validate", f.source], f.root);
  const description = await run(["meta", "recipes", "describe", f.source], f.root);
  const initialized = await run(["init", `--recipe=${f.source}`, "--name=from-ts", "--yes"], f.root);
  // Then
  expect(validation.envelope).toMatchObject({ ok: true });
  expect(description.code).toBe(0);
  expect(validation.envelope.result).toMatchObject({
    initializable: true,
    readiness: "ready",
    historyEligible: false,
  });
  expect(description.envelope.result).toMatchObject({
    initializable: true,
    readiness: "ready",
    historyEligible: false,
  });
  expect(initialized.code).toBe(0);
  expect(await Bun.file(join(f.root, "from-ts/.lando.yml")).exists()).toBe(true);
  expect(await Bun.file(join(f.root, "from-ts/.lando.yml")).text()).toContain("alpine:1");
});

test("a small YAML source and child initialize typed false and inherited binary bytes through the CLI", async () => {
  // Given a handwritten source, with no snapshot, digest, provider or internal author helpers.
  const f = await fixture(
    "options:\n  enabled:\n    type:\n      kind: boolean\n    default: true\nvariants:\n  - when: options.enabled\n    config:\n      services:\n        cache:\n          type: redis\nfiles:\n  - src: asset.bin\n    dest: assets/copied.bin\n",
  );
  const bytes = new Uint8Array([0, 255, 254, 128, 13, 10, 0, 42]);
  await Bun.write(join(f.source, "asset.bin"), bytes);
  const child = join(f.root, "child");
  await mkdir(child);
  await Bun.write(
    join(child, "recipe.yml"),
    "id: child\ntitle: Child\ndescription: Overrides only the image\nversion: 1.0.0\nextends: ../small\nconfig:\n  services:\n    app:\n      image: alpine:3.22\n",
  );
  // When the author validates, describes, initializes and reads each generated app without a runtime.
  for (const [source, name, image] of [
    [f.source, "simple-app", "alpine:3.21"],
    [child, "child-app", "alpine:3.22"],
  ] as const) {
    const validation = await run(["meta", "recipes", "validate", source], f.root);
    const description = await run(["meta", "recipes", "describe", source], f.root);
    const initialized = await run(
      ["init", `--recipe=${source}`, `--name=${name}`, "--answer=enabled=false", "--no-interactive"],
      f.root,
    );
    const appRoot = join(f.root, name);
    const config = await run(["app:config"], appRoot);
    // Then parent config, child overrides, boolean values and binary bytes survive the real CLI.
    for (const result of [validation, description, initialized, config])
      expect(result.code, result.stderr).toBe(0);
    for (const result of [validation, description])
      expect(result.envelope.result).toMatchObject({
        initializable: true,
        readiness: "ready",
        historyEligible: true,
      });
    expect(initialized.envelope.result).toMatchObject({
      answers: { enabled: false },
      receipt: {
        created: expect.arrayContaining([
          expect.objectContaining({ path: ".lando.yml" }),
          expect.objectContaining({ path: "assets/copied.bin" }),
        ]),
      },
    });
    expect(config.envelope.result.landofile).toMatchObject({
      name,
      recipe: { options: { enabled: false } },
      services: { app: { type: "lando", image } },
    });
    expect(config.envelope.result.landofile.services).not.toHaveProperty("cache");
    expect(new Uint8Array(await Bun.file(join(appRoot, "assets/copied.bin")).arrayBuffer())).toEqual(bytes);
  }
}, 30_000);
