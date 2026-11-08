import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "@lando/sdk/services";
import type { SourceTransports } from "@lando/source-acquisition";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { installEngineComposition } from "../../src/composition.ts";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("planner-stage invalid lint does not publish acquired include pins", async () => {
  // Given: native finalization accepts this event; planner resolution rejects its unknown task.
  const previous = globalThis.__landoEngineCompositionInputs;
  if (previous === undefined) throw new TypeError("Test preload must install engine composition");
  const root = await mkdtemp(join(tmpdir(), "lando-planner-lint-inspection-"));
  let clones = 0;
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: inspect\nincludes:\n  - source: github:acme/shared\n    path: fragment.yml\n",
    );
    const sources: SourceTransports = {
      git: {
        fetch: async ({ dest }) => {
          clones++;
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "fragment.yml"), "events:\n  pre-unknown-task:\n    - echo wrong\n");
          return { commit: "a".repeat(40) };
        },
      },
    };
    installEngineComposition({
      ...previous,
      landofileSourcePorts: () => ({ sources }),
      landofileRuntimeInputs: {
        ...previous.landofileRuntimeInputs,
        ports: {
          ...previous.landofileRuntimeInputs.ports,
          resolveUserCacheRoot: () => join(root, "cache"),
          resolveUserIncludesDir: () => join(root, "includes"),
          sources,
        },
      },
    });
    const cacheRoot = join(root, "cache");
    const store = makeStateStore({
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      roots: {
        userConfRoot: cacheRoot,
        userCacheRoot: cacheRoot,
        userDataRoot: cacheRoot,
        systemPluginRoot: cacheRoot,
      },
    });

    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provide(PluginRegistryLayer.layer),
        Effect.provideService(StateStore, store),
      ),
    );

    // Then: the planner-only finding proves lint reached the post-finalization stage.
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        rule: "landofile.event",
        path: ["events", "pre-unknown-task"],
        scopes: ["effective"],
      }),
    ]);
    expect(clones).toBe(1);
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  } finally {
    installEngineComposition(previous);
    await rm(root, { recursive: true, force: true });
  }
});
