import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName, serviceAppMount } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistry from "../../src/plugins/registry.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { loadLandofileLayers } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("a catalog type override does not grant identity to a Compose include's custom image", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-compose-home-"));
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  web:\n    image: example/custom-node:22\n");
    await writeFile(
      join(root, ".lando.yml"),
      "name: include-home\ninclude: [compose.yaml]\nservices:\n  web:\n    type: node:22\n",
    );
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* loadLandofileLayers(root, join(root, ".lando.yml"));
        return yield* (yield* AppPlanner).plan(compiled, TestRuntimeProvider.capabilities);
      }).pipe(
        Effect.provide(Planner.layer),
        Effect.provide(PluginRegistry.layer),
        Effect.provide(FileSystem.layer),
        Effect.provide(makeTestStateStore().layer),
      ),
    );
    expect(plan.services[ServiceName.make("web")]?.home).toEqual({
      state: "unknown",
      reason: "custom-image",
    });
    expect(plan.stores).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "include: [mailstack/compose.yaml]",
  "includes:\n  - source: ./mailstack/compose.yaml\n    kind: compose",
])("lints and plans fragment-local env files and binds alongside named volumes: %s", async (include) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-compose-include-plan-"));
  try {
    await mkdir(join(root, "mailstack/data"), { recursive: true });
    await writeFile(join(root, "mailstack/.env.mail"), "MAIL_SOURCE=fragment\n");
    await writeFile(join(root, ".lando.yml"), `name: compose-include\n${include}\n`);
    await writeFile(
      join(root, "mailstack/compose.yaml"),
      "services:\n  mail:\n    image: axllent/mailpit:v1.27\n    env_file: [.env.mail]\n    volumes: ['./data:/data']\n  postgres:\n    image: postgres:17\n    volumes: [dbdata:/var/lib/postgresql/data]\nvolumes:\n  dbdata: {}\n",
    );
    // When
    const { lint, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const lint = yield* appConfigLint({ cwd: root });
        const compiled = yield* loadLandofileLayers(root, join(root, ".lando.yml"));
        const planner = yield* AppPlanner;
        const plan = yield* planner.plan(compiled, TestRuntimeProvider.capabilities);
        return { lint, plan };
      }).pipe(
        Effect.provide(Planner.layer),
        Effect.provide(PluginRegistry.layer),
        Effect.provide(FileSystem.layer),
        Effect.provide(makeTestStateStore().layer),
      ),
    );
    // Then
    expect(lint.valid).toBe(true);
    expect(lint.violations.filter(({ severity }) => severity === "error")).toEqual([]);
    expect(Object.keys(plan.services).sort()).toEqual(["mail", "postgres"]);
    expect(Object.values(plan.services).map(({ artifact }) => artifact)).toEqual([
      { kind: "ref", ref: "axllent/mailpit:v1.27" },
      { kind: "ref", ref: "postgres:17" },
    ]);
    const mounts = Object.values(plan.services).flatMap((service) => service.mounts);
    expect(mounts.filter((mount) => mount.type === "volume")).toMatchObject([
      { target: "/var/lib/postgresql/data" },
    ]);
    expect(Object.values(plan.services).find(({ name }) => name === "mail")?.environment).toMatchObject({
      MAIL_SOURCE: "fragment",
    });
    expect(mounts.filter((mount) => mount.type === "bind")).toMatchObject([
      { source: join(root, "mailstack/data"), target: "/data" },
    ]);
    for (const service of Object.values(plan.services)) expect(serviceAppMount(service)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
