import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-lint-invocation-scopes-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const write = (file: string, content: string) => writeFile(join(root, file), content);
const lint = () =>
  Effect.runPromise(
    lintLandofileSnapshot(
      { cwd: root },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );

test.each([false, true])(
  "locates every deferred scope including an included site, with deps=%s (#2225)",
  async (deps) => {
    await write(
      ".lando.yml",
      `name: scopes\nincludes: [fragment.yml]\ntooling:\n  inspect:\n    cmd: echo {{ sources }}\n${deps ? "    deps: [other]\n" : ""}`,
    );
    await write("fragment.yml", "tooling:\n  build:\n    cmd: echo {{ generates }}\n");

    const { result } = await lint();

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(deps ? 3 : 2);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "landofile.load",
          reason: "NotImplementedError",
          path: ["tooling", "inspect", "cmd"],
          source: {
            file: join(root, ".lando.yml"),
            layer: "canonical",
            path: ["tooling", "inspect", "cmd"],
          },
          line: 5,
          column: 5,
        }),
        expect.objectContaining({
          rule: "landofile.load",
          reason: "NotImplementedError",
          path: ["tooling", "build", "cmd"],
          source: {
            file: join(root, "fragment.yml"),
            layer: "canonical",
            path: ["tooling", "build", "cmd"],
          },
          line: 3,
          column: 5,
        }),
        ...(deps ? [expect.objectContaining({ path: ["tooling", "inspect", "deps"] })] : []),
      ]),
    );
  },
);

test("locates a deferred scope in its overlay (#2225)", async () => {
  await write(".lando.yml", "name: scopes\ntooling:\n  inspect:\n    cmd: echo base\n");
  await write(".lando.local.yml", "tooling:\n  inspect:\n    cmd: echo {{ sources }}\n");

  const { result } = await lint();

  expect(result.violations).toEqual([
    expect.objectContaining({
      path: ["tooling", "inspect", "cmd"],
      source: {
        file: join(root, ".lando.local.yml"),
        layer: "local",
        path: ["tooling", "inspect", "cmd"],
      },
      line: 3,
      column: 5,
    }),
  ]);
});

test("retains same-message refusals from the same included file in distinct layers (#2225)", async () => {
  await write(".lando.yml", "name: scopes\nincludes: [fragment.yml]\n");
  await write(".lando.local.yml", "includes: [fragment.yml]\n");
  await write("fragment.yml", "tooling:\n  inspect:\n    cmd: echo {{ sources }}\n");

  const { result } = await lint();

  expect(result.violations).toHaveLength(2);
  expect(result.violations[1]?.message).toBe(result.violations[0]?.message);
  expect(result.violations.map(({ source }) => source)).toEqual([
    { file: join(root, "fragment.yml"), layer: "canonical", path: ["tooling", "inspect", "cmd"] },
    { file: join(root, "fragment.yml"), layer: "local", path: ["tooling", "inspect", "cmd"] },
  ]);
});
