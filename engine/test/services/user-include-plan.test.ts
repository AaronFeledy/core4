import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { resolveLandofileIncludes } from "@lando/landofile/includes";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeStateStore } from "@lando/state-store/service";
import { landofileRuntimeInputs } from "../../src/composition.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

test("plans user profile build context and env_file from the consuming app root", async () => {
  // Given: app and profile directories contain deliberately different env files.
  const root = await mkdtemp(join(tmpdir(), "lando-user-plan-review-"));
  const appRoot = join(root, "app");
  const includesRoot = join(root, "includes");
  await mkdir(join(appRoot, "docker"), { recursive: true });
  await mkdir(join(includesRoot, "docker"), { recursive: true });
  await writeFile(join(appRoot, "app.env"), "ORIGIN=app\n");
  await writeFile(join(includesRoot, "app.env"), "ORIGIN=profile\n");
  await writeFile(join(appRoot, "docker", "Dockerfile"), "FROM alpine:latest\n");
  await writeFile(
    join(includesRoot, "profile.yml"),
    "services:\n  web:\n    type: compose\n    build:\n      context: ./docker\n    env_file:\n      - ./app.env\n    environment:\n      VALUE: '${secret:OPAQUE}'\n",
  );
  try {
    const landofile = await Effect.runPromise(
      resolveLandofileIncludes({
        landofile: { name: "user-paths", includes: ["user:profile.yml"] },
        appRoot,
        cacheRoot: join(root, "cache"),
        ports: { ...landofileRuntimeInputs().ports, resolveUserIncludesDir: () => includesRoot },
        stateStore: makeStateStore({
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      }),
    );

    // When: the real planner consumes the merged fragment.
    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(landofile, { ...TestRuntimeProvider.capabilities, artifactBuild: true }),
      ).pipe(
        Effect.provide(AppPlannerLive.pipe(Layer.provide(Layer.merge(PluginRegistryLive, FileSystemLive)))),
      ),
    );

    // Then: provider build input and loaded env use the app, while the secret stays a reference.
    const web = plan.services[ServiceName.make("web")];
    expect(plan.root).toBe(AbsolutePath.make(appRoot));
    expect(web?.artifact).toMatchObject({ kind: "build", context: join(appRoot, "docker") });
    expect(web?.environment).toMatchObject({ ORIGIN: "app", VALUE: "${secret:OPAQUE}" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
