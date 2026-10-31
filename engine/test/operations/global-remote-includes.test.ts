import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { sha256Hex } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { GlobalAppService, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, type Layer, Schema } from "effect";
import { installEngineComposition } from "../../src/composition.ts";
import { prepareGlobalConfiguration } from "../../src/global-app/preparation.ts";
import { globalInstall, installAndLoadGlobalPlan } from "../../src/operations/global-install.ts";
import { globalEnable, globalReconcile } from "../../src/operations/global-policy.ts";
import { withReadOnlyLandofile } from "../../src/services/landofile-live.ts";
import { makeGlobalLifecycleFixture } from "../../src/testing/global-lifecycle.ts";

const previous = globalThis.__landoEngineCompositionInputs;
const revision = "a".repeat(40);
const fragment = "services:\n  remote:\n    type: compose\n    image: remote:v1\n";
const pin = {
  source: "github:acme/shared/fragment.yml",
  version: "main",
  resolved: revision,
  checksum: sha256Hex(fragment),
};
let directory = "";
let fixture: ReturnType<typeof makeGlobalLifecycleFixture>;
let acquisitions: Array<string | undefined> = [];
const store = makeStateStore({
  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
});
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof fixture.layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(StateStore, store), Effect.provide(fixture.layer)));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-global-remote-"));
  fixture = makeGlobalLifecycleFixture(directory);
  acquisitions = [];
  await mkdir(fixture.root);
  await writeFile(
    join(fixture.root, ".lando.ts"),
    `let evaluations = 0;
export default () => ({ includes: [{ source: "github:acme/shared", path: "fragment.yml", version: "main" }],
services: { authored: { type: "compose", image: "authored:" + (++evaluations) } } });\n`,
  );
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected acquisition");
  };
  const inputs: LandofileRuntimeInputs = {
    templates: { modules: [] },
    ports: {
      resolveUserCacheRoot: () => join(directory, "cache"),
      resolveUserIncludesDir: () => join(directory, "includes"),
      git: {
        clone: async ({ dest, ref }) => {
          acquisitions.push(ref);
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "fragment.yml"), fragment);
          return { commitSha: revision };
        },
      },
      npmRecipeSource: { resolve: unused },
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
    resolveContainerHelper: () => Effect.die("Unused helper"),
  });
});
afterEach(async () => {
  globalThis.__landoEngineCompositionInputs = previous;
  await rm(directory, { recursive: true, force: true });
});

const writePin = () =>
  writeFile(
    join(fixture.root, ".lando.lock.yml"),
    `includes:\n  - source: ${pin.source}\n    version: main\n    resolved: ${revision}\n    checksum: ${pin.checksum}\n`,
  );
const compile = Effect.gen(function* () {
  const preparation = yield* prepareGlobalConfiguration();
  return yield* preparation.compile(yield* preparation.resolve());
});

test.each([false, true])(
  "cold startup acquires remote includes and reuses its compiled candidate (pinned=%s)",
  async (pinned) => {
    // Given
    if (pinned) await writePin();
    // When
    const loaded = await run(installAndLoadGlobalPlan());
    // Then
    expect(acquisitions).toEqual([pinned ? revision : "main"]);
    expect(loaded.landofile.document.services).toMatchObject({
      remote: { image: "remote:v1" },
      authored: { image: "authored:1" },
    });
    expect(fixture.planned).toEqual([loaded.landofile]);
    expect(Bun.YAML.parse(await Bun.file(join(fixture.root, ".lando.lock.yml")).text())).toEqual({
      includes: [pin],
    });
  },
);

test("ordinary reconciliation publishes the selected remote pins", async () => {
  // Given: an unpinned remote request.
  // When
  const result = await run(globalReconcile());
  // Then
  expect(result.pending).toEqual([]);
  expect(acquisitions).toEqual(["main"]);
  expect(Bun.YAML.parse(await Bun.file(join(fixture.root, ".lando.lock.yml")).text())).toEqual({
    includes: [pin],
  });
});

test("enable publishes pins from its validated candidate without reevaluating authors", async () => {
  // Given
  const module = join(directory, "mail.ts");
  await writeFile(
    module,
    'import { Effect } from "effect"; export default Effect.succeed({ type: "compose", image: "mail:v1" });\n',
  );
  fixture = makeGlobalLifecycleFixture(directory, [
    Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/mail",
      version: "1.0.0",
      api: 4,
      contributes: { globalServices: [{ id: "mail", module }] },
    }),
  ]);
  // When
  const result = await run(globalEnable({ selectors: ["mail"] }));
  // Then
  expect(result.pending).toEqual([]);
  expect(acquisitions).toEqual(["main"]);
  expect(Bun.YAML.parse(await Bun.file(join(fixture.root, ".lando.lock.yml")).text())).toEqual({
    includes: [pin],
  });
});

test.each([false, true])(
  "preview with a cold remote stays no-network and no-writes (pinned=%s)",
  async (pinned) => {
    // Given
    if (pinned) await writePin();
    const before = await readdir(fixture.root);
    const outer = await readdir(directory);
    // When
    const result = await run(Effect.result(withReadOnlyLandofile(compile)));
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileIncludeError" } });
    expect(acquisitions).toEqual([]);
    expect(await readdir(fixture.root)).toEqual(before);
    expect(await readdir(directory)).toEqual(outer);
  },
);

test("warm pinned dry-run reads cached includes without publication", async () => {
  // Given
  await writePin();
  const cache = join(directory, "cache", "includes", "git", revision);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "fragment.yml"), fragment);
  const before = await Bun.file(join(fixture.root, ".lando.lock.yml")).text();
  // When
  const result = await run(globalReconcile({ dryRun: true }));
  // Then
  expect(result.dryRun).toBe(true);
  expect(acquisitions).toEqual([]);
  expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).text()).toBe(before);
  expect(await Bun.file(join(fixture.root, ".lando.dist.yml")).exists()).toBe(false);
});

test("invalid finalization never publishes newly acquired pins", async () => {
  // Given
  await writeFile(join(fixture.root, ".lando.local.yml"), "runtime: wrong\n");
  // When
  const result = await run(Effect.result(globalInstall()));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
  expect(acquisitions).toEqual(["main"]);
  expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.root, ".lando.dist.yml")).exists()).toBe(false);
});

test("failed generated publication never publishes acquired pins", async () => {
  // Given
  const operation = Effect.gen(function* () {
    const global = yield* GlobalAppService;
    return yield* globalInstall().pipe(
      Effect.provideService(GlobalAppService, {
        ...global,
        regenerateDist: () =>
          Effect.fail(
            new GlobalAppError({
              operation: "regenerateDist",
              message: "fixture failure",
              remediation: "Retry",
            }),
          ),
      }),
    );
  });
  // When
  const result = await run(Effect.result(operation));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalAppError" } });
  expect(acquisitions).toEqual(["main"]);
  expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
});

test("unchanged reconciliation retains failed compilation without reevaluating its candidate", async () => {
  // Given
  await writeFile(join(fixture.root, ".lando.local.yml"), "runtime: wrong\n");
  // When
  const result = await run(Effect.result(globalReconcile()));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "GlobalPolicyReconciliationError" } });
  expect(acquisitions).toEqual(["main"]);
  expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
});
