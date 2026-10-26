import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistry from "../../src/plugins/registry.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import { loadLandofileLayers } from "../../src/services/landofile-live.ts";
import * as Planner from "../../src/services/planner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test.each([
  "include: [sibling/compose.yaml]",
  "includes:\n  - source: ./sibling/compose.yaml\n    kind: compose",
])("lints and plans a stock Compose include with named volumes: %s", async (include) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-compose-include-plan-"));
  try {
    await mkdir(join(root, "sibling"));
    await writeFile(join(root, ".lando.yml"), `name: compose-include\n${include}\n`);
    await writeFile(
      join(root, "sibling/compose.yaml"),
      "services:\n  mail:\n    image: axllent/mailpit:v1.27\n  postgres:\n    image: postgres:17\n    volumes: [dbdata:/var/lib/postgresql/data]\nvolumes:\n  dbdata: {}\n",
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
    expect(Object.values(plan.services).flatMap(({ storage }) => storage)).toMatchObject([
      { target: "/var/lib/postgresql/data" },
    ]);
    for (const service of Object.values(plan.services)) {
      expect(service.mounts).toEqual([]);
      expect(service.appMount).toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
