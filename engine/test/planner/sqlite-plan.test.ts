import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as Plugins from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

test("the final plan keeps the canonical SQLite path on the declaring service", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sqlite-plan-"));
  try {
    const document = Schema.decodeUnknownSync(LandofileShape)({
      name: "sqliteplan",
      runtime: 4,
      services: { web: { type: "compose", image: "alpine", sqlite: { path: "./data//site.sqlite" } } },
    });

    const plan = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(document, root), TestRuntimeProvider.capabilities),
      ).pipe(
        Effect.provide(Planner.layer.pipe(Layer.provide(Layer.mergeAll(Plugins.layer, BunFileSystem.layer)))),
      ),
    );

    const web = plan.services[ServiceName.make("web")];
    expect(web?.sqlite).toEqual({ path: "data/site.sqlite" });
    expect(web?.connection).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
