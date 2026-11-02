import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { installEngineComposition } from "../../src/composition.ts";
import { appConfigEdit, appConfigSet, appConfigUnset } from "../../src/operations/app-config-write.ts";
import { loadLandofileLayers } from "../../src/services/landofile-live.ts";

const previous = globalThis.__landoEngineCompositionInputs;
let root = "";
let app = "";
const original = "name: original\nruntime: 4\n";
const remote = "includes:\n  - source: github:acme/shared\n    path: fragment.yml\n";
let clones = 0;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-app-config-candidate-"));
  app = join(root, "app");
  await mkdir(app);
  await writeFile(join(app, ".lando.yml"), original);
  clones = 0;
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected acquisition");
  };
  const inputs: LandofileRuntimeInputs = {
    templates: { modules: [] },
    ports: {
      resolveUserCacheRoot: () => join(root, "cache"),
      resolveUserIncludesDir: () => join(root, "includes"),
      git: {
        clone: async ({ dest }) => {
          clones++;
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "fragment.yml"), "services:\n  web:\n    image: alpine\n");
          return { commitSha: "a".repeat(40) };
        },
      },
      npmRecipeSource: { resolve: unused, fetchTarball: unused },
      tarball: { fetch: unused, extract: unused },
      publication: { publish: rename },
    },
  };
  installEngineComposition({
    bundledPluginModules: [],
    builtInCommandIds: [],
    landofileRuntimeInputs: inputs,
    landofileSourcePorts: () => inputs.ports,
    hostProxyWorkerEntry: () => ({
      execPath: process.execPath,
      entryPath: undefined,
      bunSourceEntryPath: "unused",
    }),
    resolveContainerHelper: () => Effect.die("Unused container helper"),
  });
});
afterEach(async () => {
  globalThis.__landoEngineCompositionInputs = previous;
  await rm(root, { recursive: true, force: true });
});

const store = makeStateStore({
  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
});
const run = <A, E>(effect: Effect.Effect<A, E, StateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(StateStore, store)));

for (const dryRun of [true, false]) {
  test.each(["set", "unset", "edit"] as const)(
    `%s saves only the Landofile (dryRun=${dryRun})`,
    async (verb) => {
      // Given
      const initial = verb === "unset" ? `${original}${remote}` : original;
      await writeFile(join(app, ".lando.yml"), initial);
      // When
      switch (verb) {
        case "set":
          await run(
            appConfigSet({
              cwd: app,
              key: "includes",
              value: '[{"source":"github:acme/shared","path":"fragment.yml"}]',
              type: "json",
              dryRun,
            }),
          );
          break;
        case "unset":
          await run(appConfigUnset({ cwd: app, key: "runtime", dryRun }));
          break;
        case "edit":
          await run(
            appConfigEdit({
              cwd: app,
              dryRun,
              editorRunner: async () => ({ kind: "edited", content: `${original}${remote}` }),
            }),
          );
          break;
      }
      // Then
      expect(await readdir(app)).toEqual([".lando.yml"]);
      const saved = await Bun.file(join(app, ".lando.yml")).text();
      if (dryRun) {
        expect(saved).toBe(initial);
      } else {
        expect(Bun.YAML.parse(saved)).toEqual({
          name: "original",
          ...(verb === "unset" ? {} : { runtime: 4 }),
          includes: [{ source: "github:acme/shared", path: "fragment.yml" }],
        });
      }
      expect(clones).toBeGreaterThan(0);
    },
  );
}

test("ordinary load pins after a successful edit", async () => {
  // Given
  await run(
    appConfigEdit({
      cwd: app,
      editorRunner: async () => ({ kind: "edited", content: `${original}${remote}` }),
    }),
  );
  expect(await Bun.file(join(app, ".lando.lock.yml")).exists()).toBe(false);
  // When
  await run(loadLandofileLayers(app, join(app, ".lando.yml")));
  // Then
  expect(await Bun.file(join(app, ".lando.lock.yml")).text()).toContain(`resolved: ${"a".repeat(40)}`);
});

test("unchanged unset does not publish pins", async () => {
  // Given
  await writeFile(join(app, ".lando.yml"), `${original}${remote}`);
  // When
  const result = await run(appConfigUnset({ cwd: app, key: "missing" }));
  // Then
  expect(result.changed).toBe(false);
  expect(await readdir(app)).toEqual([".lando.yml"]);
});

test("a rejected effective candidate does not publish pins", async () => {
  // Given
  const candidate = `name: candidate\n${remote}`;
  await writeFile(join(app, ".lando.local.yml"), "runtime: wrong\n");
  // When
  const result = await run(
    appConfigEdit({ cwd: app, editorRunner: async () => ({ kind: "edited", content: candidate }) }).pipe(
      Effect.result,
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
  expect(clones).toBeGreaterThan(0);
  expect(await readdir(app)).toEqual([".lando.local.yml", ".lando.yml"]);
  expect(await Bun.file(join(app, ".lando.yml")).text()).toBe(original);
});

test("inference propagates a pending transaction without recovering it", async () => {
  // Given
  const guard = ManagedFileTransactionGuard.of({
    assertReadable: () =>
      Effect.fail(
        new ManagedFileTransactionError({
          reason: "pending-transaction",
          phase: "inspect",
          path: app,
          cause: "invariant",
          remediation: "Recover the transaction with an ordinary load.",
        }),
      ),
    ensureConsistent: () => Effect.die("Candidate must not recover"),
    pending: () => Effect.succeed({ id: "pending", state: "prepared", action: "recover", targets: [] }),
  });
  // When
  const result = await run(
    appConfigSet({ cwd: app, key: "runtime", value: "4" }).pipe(
      Effect.provideService(ManagedFileTransactionGuard, guard),
      Effect.result,
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ManagedFileTransactionError", reason: "pending-transaction", phase: "inspect" },
  });
  expect(await Bun.file(join(app, ".lando.yml")).text()).toBe(original);
});
