import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";
import * as Cache from "@lando/engine/cache/service";
import * as Plugins from "@lando/engine/plugins/registry";
import * as Files from "@lando/engine/services/file-system";
import * as Planner from "@lando/engine/services/planner";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { withCwd, withEnvVar } from "../_support/temp-cwd.ts";
import { literalLandofile } from "../_support/value-contracts.ts";

test("cache hits fail closed for authored networks and bridge aliases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-network-cache-")));
  try {
    await withCwd(
      root,
      () =>
        withEnvVar("LANDO_USER_CACHE_ROOT", root, async () => {
          const landofile = Schema.decodeUnknownSync(LandofileShape)({
            name: "cached-networks",
            runtime: 4,
            services: { web: { image: "node:lts", home: false } },
          });
          const { authoredNetworks: _authoredNetworks, ...capabilities } = TestRuntimeProvider.capabilities;
          const layer = Planner.layer.pipe(
            Layer.provide(Layer.mergeAll(Cache.layer, Files.layer, Plugins.layer)),
          );
          const run = () =>
            Effect.runPromise(
              Effect.flatMap(AppPlanner, (planner) =>
                planner.plan(literalLandofile(landofile, root), capabilities),
              ).pipe(Effect.result, Effect.provide(layer)),
            );
          const seeded = await run();
          if (Result.isFailure(seeded)) throw new Error("Expected cache seed");
          const bytes = await readFile(appPlanCachePath(root, "cached-networks", root));
          const { key } = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
            deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
          );
          for (const networking of [
            {
              perAppBridge: {
                name: "lando-cached-networks",
                aliases: { [ServiceName.make("web")]: ["api"] },
              },
            },
            {
              perAppBridge: null,
              authoredNetworks: [{ key: "peer", name: "peer", external: true, members: {} }],
            },
          ]) {
            await Effect.runPromise(
              writeCachedAppPlan({
                appRoot: root,
                cacheRoot: root,
                appName: "cached-networks",
                key,
                plan: { ...seeded.success, networking },
              }).pipe(Effect.provide(Cache.layer)),
            );
            const result = await run();
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({
                _tag: "CapabilityError",
                capability: "authoredNetworks",
                feature: "authored networks",
              });
          }
        }),
      [root],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
