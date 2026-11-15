import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { CommandRegistry, LandofileService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { readFreshAppCommandCacheForCwd } from "../../src/cache/command-index-writer.ts";
import * as CommandRegistryLayer from "../../src/services/command-registry.ts";
import { loadLandofileLayers } from "../../src/services/landofile-live.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("live registry retains TypeScript and included disable sources in its command cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-registry-source-"));
  const file = join(root, ".lando.ts");
  const included = join(root, "tasks.yml");
  try {
    await writeFile(
      file,
      'export default { name: "sources", tooling: { off: false }, toolingIncludes: { extra: { file: "./tasks.yml", flatten: true } } };',
    );
    await writeFile(included, "tooling:\n  included: false\n");
    const loaded = await Effect.runPromise(
      loadLandofileLayers(root, file).pipe(Effect.provide(makeTestStateStore().layer)),
    );
    const cached = await Effect.runPromise(
      withResolvedCwd(
        root,
        Effect.gen(function* () {
          yield* Effect.flatMap(CommandRegistry, (registry) => registry.list).pipe(
            Effect.provide(
              CommandRegistryLayer.layer.pipe(
                Layer.provide(
                  Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.succeed(loaded) })),
                ),
              ),
            ),
          );
          return yield* readFreshAppCommandCacheForCwd({ cwd: root });
        }),
      ),
    );
    expect(cached?.entries).toEqual([
      {
        id: "app:included",
        summary: "",
        visibility: "public",
        sourceKind: "tooling",
        _tag: "Disabled",
        source: { path: included, task: "included" },
      },
      {
        id: "app:off",
        summary: "",
        visibility: "public",
        sourceKind: "tooling",
        _tag: "Disabled",
        source: { path: file, task: "off" },
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
