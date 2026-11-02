import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifest } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { readGlobalPolicy } from "../../src/global-app/enablement.ts";
import { prepareGlobalConfiguration } from "../../src/global-app/preparation.ts";
import { renderGlobalDist } from "../../src/global-app/service.ts";
import { globalInstall, installAndLoadGlobalPlan } from "../../src/operations/global-install.ts";
import { makeGlobalLifecycleFixture } from "../../src/testing/global-lifecycle.ts";

const withFixture = async (
  use: (fixture: ReturnType<typeof makeGlobalLifecycleFixture>) => Promise<void>,
  config = "",
) => {
  const directory = await mkdtemp(join(tmpdir(), "lando-preparation-"));
  try {
    const module = join(directory, "mail.ts");
    await writeFile(
      module,
      `import { Effect } from "effect";
let evaluations = 0;
export default Effect.sync(() => ({ type: "compose", image: "fixture:" + (++evaluations), ${config} }));\n`,
    );
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/mail",
      version: "1.0.0",
      api: 4,
      contributes: { globalServices: [{ id: "mail", module }] },
    });
    await use(makeGlobalLifecycleFixture(directory, [manifest]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("install publishes the same eligible module result it validated", async () => {
  await withFixture(async (f) => {
    const result = await Effect.runPromise(globalInstall().pipe(Effect.provide(f.layer)));
    expect(await readFile(result.paths.distLandofile, "utf8")).toContain("image: fixture:1");
  });
});

test("startup plans the compiled candidate without reevaluating authored TypeScript", async () => {
  await withFixture(async (f) => {
    await mkdir(f.root);
    await writeFile(
      join(f.root, ".lando.ts"),
      `let evaluations = 0;
export default () => ({ services: { custom: { type: "compose", image: "authored:" + (++evaluations) } } });\n`,
    );
    const loaded = await Effect.runPromise(installAndLoadGlobalPlan().pipe(Effect.provide(f.layer)));
    expect(loaded.landofile.document.services?.custom?.image).toBe("authored:1");
    expect(f.planned).toHaveLength(1);
    expect(f.planned[0]).toBe(loaded.landofile);
    expect(await readFile(join(f.root, ".lando.dist.yml"), "utf8")).toContain("image: fixture:1");
  });
});

test("invalid ordinary install leaves fresh root and seeded policy untouched", async () => {
  await withFixture(async (f) => {
    const outcome = await Effect.runPromise(Effect.result(globalInstall()).pipe(Effect.provide(f.layer)));
    expect(outcome._tag).toBe("Failure");
    expect(await Bun.file(join(f.root, ".lando.yml")).exists()).toBe(false);
    expect(
      await stat(f.root).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect((await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(f.layer)))).revision).toBe(0);
  }, 'dependsOn: [{ service: "absent", condition: "service_started", required: true }],');
});

test("a changed authored input rejects prepared publication until explicit fresh preparation", async () => {
  await withFixture(async (f) => {
    await mkdir(f.root);
    const authored = join(f.root, ".lando.yml");
    await writeFile(authored, "name: global\n");
    const prepared = await Effect.runPromise(
      Effect.gen(function* () {
        const preparation = yield* prepareGlobalConfiguration();
        return yield* preparation.compile(yield* preparation.resolve());
      }).pipe(Effect.provide(f.layer)),
    );
    await writeFile(
      authored,
      "name: global\nservices:\n  custom:\n    type: compose\n    image: changed:v1\n",
    );
    const result = await Effect.runPromise(Effect.result(prepared.verify));
    expect(result._tag).toBe("Failure");
    expect(await Bun.file(prepared.paths.distLandofile).exists()).toBe(false);
  });
});

test("writer rejects inconsistent prepared bytes before creating bind paths or the root", async () => {
  await withFixture(async (f) => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const global = yield* GlobalAppService;
        return yield* Effect.result(
          global.regenerateDist({
            services: {},
            content: renderGlobalDist({ mail: { image: "unexpected:v1" } }),
          }),
        );
      }).pipe(Effect.provide(f.layer)),
    );
    expect(outcome._tag).toBe("Failure");
    expect(
      await stat(f.root).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});

test("prepared identical publication preserves the generated file identity", async () => {
  await withFixture(async (f) => {
    const first = await Effect.runPromise(globalInstall().pipe(Effect.provide(f.layer)));
    const before = await stat(first.paths.distLandofile);
    const content = await readFile(first.paths.distLandofile, "utf8");
    const services = { mail: { type: "compose", image: "fixture:1" } };
    const result = await Effect.runPromise(
      Effect.flatMap(GlobalAppService, (global) => global.regenerateDist({ services, content })).pipe(
        Effect.provide(f.layer),
      ),
    );
    expect(result.status).toBe("unchanged");
    expect((await stat(first.paths.distLandofile)).ino).toBe(before.ino);
  });
});

test("startup refuses provider capability changes rather than reusing stale preparation", async () => {
  await withFixture(async (f) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const global = yield* GlobalAppService;
        return yield* Effect.result(
          installAndLoadGlobalPlan().pipe(
            Effect.provideService(GlobalAppService, {
              ...global,
              regenerateDist: (input) =>
                global.regenerateDist(input).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      f.setCapabilities({
                        ...f.provider.capabilities,
                        sharedCrossAppNetwork: !f.provider.capabilities.sharedCrossAppNetwork,
                      });
                    }),
                  ),
                ),
            }),
          ),
        );
      }).pipe(Effect.provide(f.layer)),
    );
    expect(result._tag).toBe("Failure");
    expect(f.planned).toEqual([]);
  });
});
