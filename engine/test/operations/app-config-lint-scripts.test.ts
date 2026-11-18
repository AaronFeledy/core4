import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

const lint = async (scripts: Readonly<Record<string, string>>, landofile = "name: scripts\n") => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-scripts-"));
  try {
    await writeFile(join(root, ".lando.yml"), landofile);
    for (const [name, content] of Object.entries(scripts)) {
      const file = join(root, ".lando", "scripts", name);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, content);
    }
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    return { root, result };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  { label: "missing block", content: "echo hi\n", path: [], message: /missing/ },
  { label: "malformed block", content: "# ---\n# desc: x\necho hi", path: [], message: /malformed/ },
  { label: "empty file", content: "", path: [], message: /empty/ },
  {
    label: "unknown key",
    content: "# ---\n# typo: x\n# ---\necho hi",
    path: ["typo"],
    message: /excess property/,
  },
  {
    label: "unsupported key",
    content: "# ---\n# sources:\n#   - src\n# ---\necho hi",
    path: ["sources"],
    message: /not supported/,
  },
  {
    label: "wrapper",
    content: "# ---\n# wrapper: true\n# ---\necho hi",
    path: ["wrapper"],
    message: /excess property/,
  },
  {
    label: "non-host service",
    content: "# ---\n# service: web\n# ---\necho hi",
    path: ["service"],
    message: /not supported/,
  },
  {
    label: "input conflict",
    content: "# ---\n# arguments: false\n# args:\n#   name:\n# ---\necho hi",
    path: ["arguments"],
    message: /contradict/,
  },
  {
    label: "unusable canonical name",
    content: "# ---\n# desc: x\n# ---\necho hi",
    path: [],
    message: /no usable canonical name/,
    name: "!!!.bun.sh",
  },
])("reports $label as a script metadata finding", async ({ content, path, message, name }) => {
  const filename = name ?? "bad.bun.sh";
  const { root, result } = await lint({ [filename]: content });
  expect(result.valid).toBe(false);
  expect(result.violations).toEqual([
    expect.objectContaining({
      rule: "script.front-matter",
      severity: "error",
      path,
      message: expect.stringMatching(message),
      source: { layer: "script", file: join(root, ".lando/scripts", filename), path },
      suggestion: expect.any(String),
    }),
  ]);
});

test("reports YAML errors in physical script coordinates", async () => {
  const { result } = await lint({
    "bad.bun.sh": "#!/usr/bin/env bun\n\n# ---\n# desc: valid\n# flags: {invalid: true}\n# ---\necho hi",
  });
  expect(result.violations).toEqual([
    expect.objectContaining({ rule: "script.front-matter", line: 5, column: 10 }),
  ]);
});

test("locates nested schema keys in script front matter", async () => {
  const { result } = await lint({
    "bad.bun.sh": "# ---\n# flags:\n#   verbose:\n#     type: boolean\n# ---\necho hi",
  });
  expect(result.violations).toEqual([
    expect.objectContaining({ path: ["flags", "verbose", "type"], line: 4, column: 7 }),
  ]);
});

test("collects independent metadata defects within a script", async () => {
  const { result } = await lint({
    "bad.bun.sh": "# ---\n# sources:\n#   - src\n# wrapper: true\n# typo: x\n# ---\necho hi",
  });
  expect(result.violations.map(({ path }) => path)).toEqual([["sources"], ["wrapper"], ["typo"]]);
});

test("reports duplicate canonical ids without stopping other script inspection", async () => {
  const content = "# ---\n# desc: valid\n# ---\necho hi";
  const { root, result } = await lint({
    "Build.bun.sh": content,
    "build.bun.sh": content,
    "missing.bun.sh": "echo hi",
  });
  expect(result.violations.map(({ rule }) => rule)).toEqual(["script.front-matter", "script.front-matter"]);
  expect(result.violations.some(({ message }) => message.includes("same canonical id app:build"))).toBe(true);
  expect(result.violations).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("missing the front-matter block"),
      source: { layer: "script", file: join(root, ".lando/scripts/missing.bun.sh"), path: [] },
    }),
  );
});

test("reports the runtime Bun Shell body rejection with physical coordinates", async () => {
  const { root, result } = await lint({ "ops/bad.bun.sh": "# ---\n# desc: x\n# ---\necho ${NAME}" });
  expect(result.valid).toBe(false);
  expect(result.violations).toEqual([
    expect.objectContaining({
      rule: "script.host-shell",
      path: [],
      line: 4,
      column: 6,
      source: { layer: "script", file: join(root, ".lando/scripts/ops/bad.bun.sh"), path: [] },
    }),
  ]);
});

test.each([
  { label: "disabled", metadata: "# disabled: true", landofile: "name: scripts\n" },
  {
    label: "shadowed",
    metadata: "# desc: x",
    landofile: "name: scripts\ntooling:\n  bad:\n    service: ':host'\n    cmd: echo valid\n",
  },
])("skips $label script bodies", async ({ metadata, landofile }) => {
  const { result } = await lint({ "bad.bun.sh": `# ---\n${metadata}\n# ---\necho \${NAME}` }, landofile);
  expect(result).toMatchObject({ valid: true, violations: [] });
});

test("retains script metadata and body findings when the Landofile cannot load", async () => {
  const { result } = await lint(
    { "bad.bun.sh": "echo hi", "body.bun.sh": "# ---\n# desc: x\n# ---\necho ${HOME}" },
    "name: {invalid: true}\n",
  );
  expect(result.valid).toBe(false);
  expect(
    result.violations.filter(({ source }) => source?.layer === "script").map(({ rule }) => rule),
  ).toEqual(["script.front-matter", "script.host-shell"]);
  expect(result.violations.some(({ rule }) => rule === "landofile.load")).toBe(true);
});
