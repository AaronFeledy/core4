import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installEngineComposition } from "@lando/engine/composition";
import { StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { compileGlobalConfigDocument } from "../../../src/cli/commands/meta/global-config-document.ts";
import {
  globalConfigEdit,
  globalConfigSet,
  globalConfigUnset,
} from "../../../src/cli/commands/meta/global-config.ts";

const previous = globalThis.__landoEngineCompositionInputs;
let root = "";
let app = "";
const original = "name: global\nruntime: 4\n";
const remote = "includes:\n  - source: github:acme/shared\n    path: fragment.yml\n";
const store = makeStateStore({
  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
});
const run = <A, E>(effect: Effect.Effect<A, E, StateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(StateStore, store)));

beforeEach(async () => {
  if (previous === undefined) throw new Error("Test preload must install engine composition");
  root = await mkdtemp(join(tmpdir(), "lando-global-candidate-"));
  app = join(root, "app");
  await mkdir(app);
  await writeFile(join(app, ".lando.yml"), original);
  installEngineComposition({
    ...previous,
    landofileRuntimeInputs: {
      ...previous.landofileRuntimeInputs,
      ports: {
        ...previous.landofileRuntimeInputs.ports,
        resolveUserCacheRoot: () => join(root, "cache"),
        git: {
          clone: async ({ dest }) => {
            await mkdir(dest, { recursive: true });
            await writeFile(join(dest, "fragment.yml"), "services:\n  web:\n    image: alpine\n");
            return { commitSha: "a".repeat(40) };
          },
        },
        publication: { publish: rename },
      },
    },
  });
});
afterEach(async () => {
  globalThis.__landoEngineCompositionInputs = previous;
  await rm(root, { recursive: true, force: true });
});

for (const dryRun of [true, false]) {
  test.each(["set", "unset", "edit"] as const)(
    `global %s saves only the Landofile (dryRun=${dryRun})`,
    async (verb) => {
      // Given
      const file = join(app, ".lando.yml");
      const initial = verb === "unset" ? `${original}${remote}` : original;
      await writeFile(file, initial);
      // When
      switch (verb) {
        case "set":
          await run(
            globalConfigSet(
              {
                key: "includes",
                value: '[{"source":"github:acme/shared","path":"fragment.yml"}]',
                type: "json",
                dryRun,
              },
              file,
            ),
          );
          break;
        case "unset":
          await run(globalConfigUnset({ key: "runtime", dryRun }, file));
          break;
        case "edit":
          await run(
            globalConfigEdit(
              { dryRun, editorRunner: async () => ({ kind: "edited", content: `${original}${remote}` }) },
              file,
            ),
          );
          break;
      }
      // Then
      expect(await readdir(app)).toEqual([".lando.yml"]);
      const saved = await Bun.file(file).text();
      if (dryRun) {
        expect(saved).toBe(initial);
      } else {
        expect(Bun.YAML.parse(saved)).toEqual({
          name: "global",
          ...(verb === "unset" ? {} : { runtime: 4 }),
          includes: [{ source: "github:acme/shared", path: "fragment.yml" }],
        });
      }
    },
  );
}

test("global document validation keeps ordinary-load pin behavior", async () => {
  // Given
  const file = join(app, ".lando.yml");
  await writeFile(file, `${original}${remote}`);
  // When
  await run(compileGlobalConfigDocument(file));
  // Then
  expect(await Bun.file(join(app, ".lando.lock.yml")).text()).toContain(`resolved: ${"a".repeat(40)}`);
});
