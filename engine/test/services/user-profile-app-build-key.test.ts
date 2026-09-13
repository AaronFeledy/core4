import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLandofileIncludes } from "@lando/landofile/includes";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import { landofileRuntimeInputs } from "../../src/composition.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { appSteps } from "../../src/services/build-app-plan.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

test.each([
  ["VALUE: first", "VALUE: second", false],
  ["VALUE: '${secret:FIRST}'", "VALUE: '${secret:SECOND}'", false],
  ["VALUE: first", "VALUE: first # comment", true],
  ["LANDO_APP_NAME: first", "LANDO_APP_NAME: second", true],
  ["HTTP_PROXY: http://first", "HTTP_PROXY: http://second", true],
] as const)("app build identity tracks effective profile env: %s to %s", async (before, after, equal) => {
  const root = await mkdtemp(join(tmpdir(), "lando-profile-app-key-"));
  const includesRoot = join(root, "includes");
  const stateStore = makeStateStore({
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  });
  const layer = AppPlannerLive.pipe(Layer.provide(Layer.merge(PluginRegistryLive, FileSystemLive)));
  const keyFor = async (env: string) => {
    await writeFile(
      join(includesRoot, "profile.yml"),
      `services:\n  web:\n    type: compose\n    image: alpine:3.21\n    environment:\n      ${env}\n    build:\n      app:\n        - echo build\n`,
    );
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const landofile = yield* resolveLandofileIncludes({
          landofile: { name: "profile-app-key", includes: ["user:profile.yml"] },
          appRoot: root,
          cacheRoot: join(root, "cache"),
          ports: { ...landofileRuntimeInputs().ports, resolveUserIncludesDir: () => includesRoot },
          stateStore,
        });
        return yield* (yield* AppPlanner).plan(landofile, TestRuntimeProvider.capabilities);
      }).pipe(Effect.provide(layer)),
    );
    const steps = appSteps(plan);
    expect(steps).toHaveLength(1);
    return steps[0]?.step.buildKey;
  };
  try {
    await mkdir(includesRoot);
    const original = await keyFor(before);
    const changed = await keyFor(after);
    expect(changed === original).toBe(equal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
