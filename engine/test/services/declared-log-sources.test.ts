import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileFile, loadLandofileLayers } from "@lando/landofile/service";
import { AbsolutePath, LogSourceId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

for (const type of ["node:22", "compose"]) {
  for (const timestamps of [undefined, true]) {
    test.each(["file", "global"])(
      `plans declared logs from %s input (${type}, timestamps=${timestamps})`,
      async (adapter) => {
        // Given the issue's service shape on the user or global compilation path.
        const root = await mkdtemp(join(tmpdir(), "lando-plan-declared-logs-"));
        const file = join(root, ".lando.yml");
        const content = `name: declared-logs\nservices:\n  app:\n    type: ${type}\n${type === "compose" ? "    image: node:22\n    home: false\n" : ""}    command: ["node", "-e", "setInterval(()=>{},1000)"]\n    logs:\n      - path: /tmp/app.log\n        id: applog\n${timestamps === undefined ? "" : "        timestamps: true\n"}`;
        try {
          await Bun.write(file, content);

          // When the compiled Landofile passes through real bundled service resolution and planning.
          const plan = await Effect.runPromise(
            Effect.gen(function* () {
              const landofile = yield* adapter === "file"
                ? loadLandofileFile(file)
                : loadLandofileLayers(root, file);
              const planner = yield* AppPlanner;
              return yield* planner.plan(landofile, TestRuntimeProvider.capabilities);
            }).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(PluginRegistryLayer.layer)),
          );

          // Then the service plan retains the declared source and its timestamp policy.
          expect(plan.services[ServiceName.make("app")]?.logSources).toEqual([
            {
              id: LogSourceId.make("applog"),
              path: AbsolutePath.make("/tmp/app.log"),
              stream: "stderr",
              strategy: "follow",
              required: false,
              timestamps: timestamps ?? false,
            },
          ]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}
