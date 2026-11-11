import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unavailableRouterReason } from "@lando/engine/subsystems/proxy/api";
import { AppId, appIdentityKey } from "@lando/sdk/schema";
import { GlobalAppService, RouterService } from "@lando/sdk/services";
import { Context, Effect, Layer, Result } from "effect";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";

describe("router selection at bootstrap", () => {
  test("#2138 a configured router that is not installed builds an unavailable router instead of failing", async () => {
    // Given: global config names a router no installed plugin contributes.
    const runtime = makeLandoRuntime({
      bootstrap: "app",
      config: { defaultRouterService: "missing" },
      configSources: { user: false, env: false },
    });

    // When: the provider tier that selects the router is built.
    const router = await Effect.runPromise(
      Effect.scoped(Effect.map(Layer.build(runtime), (context) => Context.get(context, RouterService))),
    );

    // Then: bootstrap succeeds and the router carries the selection failure.
    expect(unavailableRouterReason(router)).toMatchObject({
      _tag: "ProxyError",
      proxyId: "missing",
    });
  });

  test("#2138 an unselectable router withdraws an owner's persisted routes through the installed Traefik router", async () => {
    // Given: a persisted Traefik route file for an app while the configured router is not installed.
    const runtime = makeLandoRuntime({
      bootstrap: "app",
      config: { defaultRouterService: "missing" },
      configSources: { user: false, env: false },
    });
    const owner = { id: AppId.make("demo"), ownerKey: appIdentityKey("owner", "/apps/demo") };

    // When: the owner's routes are withdrawn through the runtime router.
    const { file, reason, removed } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(runtime);
          const router = Context.get(context, RouterService);
          const { root } = yield* Context.get(context, GlobalAppService).paths;
          const dynamic = join(root, "proxy-traefik", "dynamic");
          const file = join(dynamic, `routes-${owner.ownerKey}.yml`);
          yield* Effect.promise(async () => {
            await mkdir(dynamic, { recursive: true });
            await writeFile(file, '# lando-route-file: {"version":1,"app":"demo"}\nhttp: {}\n');
          });
          return {
            file,
            reason: unavailableRouterReason(router)?.proxyId,
            removed: yield* Effect.result(router.removeRoutes(owner)),
          };
        }),
      ),
    );

    // Then: the router stays unavailable, yet the persisted route file is gone.
    expect({ reason, removed, persisted: existsSync(file) }).toEqual({
      reason: "missing",
      removed: Result.succeed(undefined),
      persisted: false,
    });
  });
});
