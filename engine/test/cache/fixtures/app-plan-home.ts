import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, CacheService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { plugin as serviceLando } from "@lando/service-lando";
import { Effect, Layer } from "effect";
import * as AppCacheService from "../../../src/cache/service.ts";
import * as PluginRegistryLayer from "../../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../../src/services/planner.ts";

// Given: identical authored mounts and cache location across both plans.
const appName = process.argv[2];
assert.ok(appName);
const shouldWrite = process.argv[3] === "true";
const appRoot = process.cwd();
const service = ServiceName.make("web");
const landofile: LandofileShape = {
  name: appName,
  services: {
    [service]: {
      type: "compose",
      image: "alpine:3.22",
      home: false,
      appMount: false,
      mounts: ["~/.ssh:/ssh:ro", "~:/host-home:ro", "/var/run/example.sock:/socket", "./relative:/relative"],
    },
  },
};
await writeFile(join(appRoot, ".lando.yml"), JSON.stringify(landofile));
let writes = 0;
const cacheLayer = Layer.effect(
  CacheService,
  Effect.map(CacheService, (cache) =>
    CacheService.of({
      ...cache,
      writeAtomic: (path, bytes) =>
        Effect.suspend(() => {
          writes += 1;
          return cache.writeAtomic(path, bytes);
        }),
    }),
  ),
).pipe(Layer.provide(AppCacheService.layer));
const plannerLayer = AppPlannerLayer.layer.pipe(
  Layer.provide(
    Layer.mergeAll(cacheLayer, PluginRegistryLayer.layerWith({ user: false, app: false }, [serviceLando])),
  ),
);
// When
const next = await Effect.runPromise(
  Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
    Effect.provide(plannerLayer),
  ),
);

// Then: only tilde sources change, and unchanged home avoids a cache rewrite.
const mounts = next.services[service]?.mounts;
assert.equal(mounts?.find((mount) => mount.target === "/ssh")?.source, `${homedir()}/.ssh`);
assert.equal(mounts?.find((mount) => mount.target === "/host-home")?.source, homedir());
assert.equal(mounts?.find((mount) => mount.target === "/socket")?.source, "/var/run/example.sock");
assert.equal(mounts?.find((mount) => mount.target === "/relative")?.source, join(appRoot, "relative"));
assert.equal(writes, shouldWrite ? 1 : 0);
