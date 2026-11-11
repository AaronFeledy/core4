import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as GlobalAppRuntime from "@lando/engine/global-app/runtime";
import * as EventService from "@lando/engine/services/event-service";
import { makeGlobalLifecycleFixture } from "@lando/engine/testing/global-lifecycle";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  BuildOrchestrator,
  EnvironmentValueResolver,
  GlobalAppService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { routeFile } from "../src/proxy-paths.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";
import { routeMetadataLine, routeOwner } from "./route-owner-fixture.ts";

test.each([
  { kind: "user", state: "idle" },
  { kind: "global", state: "idle" },
  { kind: "user", state: "running" },
  { kind: "global", state: "running" },
] as const)(
  "Windows withdraws $kind routes and preserves reload failures when runtime is $state",
  async ({ kind, state }) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-idle-windows-routes-")));
    try {
      const global = makeGlobalLifecycleFixture(base);
      global.setOnline(state === "running");
      const failure = new ProviderUnavailableError({
        providerId: "lando",
        operation: "list",
        message: "named pipe is absent",
        remediation: "Inspect runtime.",
      });
      const provider = {
        ...global.provider,
        isAvailable: Effect.succeed(true),
        list: () => Effect.fail(failure),
        restart: () => Effect.die("idle route withdrawal must not restart the runtime"),
      };
      const runtime = GlobalAppRuntime.layer.pipe(
        Layer.provide(EventService.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RuntimeProviderRegistry, {
              ...global.registry,
              select: () => Effect.succeed(provider),
            }),
            Layer.succeed(BuildOrchestrator, {
              build: () => Effect.die("withdrawal must not build"),
              buildApp: () => Effect.die("withdrawal must not build"),
            }),
            Layer.succeed(EnvironmentValueResolver, {
              openSession: () => Effect.die("withdrawal must not resolve environment"),
            }),
          ),
        ),
        Layer.provide(global.layer),
      );
      const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(runtime)));
      const fixture = makeAcceptanceFixture("win32");
      const owner = routeOwner(kind === "global" ? "global" : "example", join(base, kind));
      const sibling = routeOwner("sibling", join(base, "sibling"));
      const file = routeFile(fixture.dependencies.paths, owner);
      const siblingFile = routeFile(fixture.dependencies.paths, sibling);
      fixture.files.set(file, `${routeMetadataLine(owner)}\npersisted routes`);
      fixture.files.set(siblingFile, `${routeMetadataLine(sibling)}\nsibling routes`);
      const service = makeTraefikRouterService({
        ...fixture.dependencies,
        globalApp,
      });

      const result = await Effect.runPromise(service.removeRoutes(owner).pipe(Effect.result));

      expect(result).toMatchObject(
        state === "idle"
          ? { _tag: "Success" }
          : {
              _tag: "Failure",
              failure: {
                _tag: "ProxyError",
                cause: {
                  _tag: "GlobalAppError",
                  operation: "restartRunningService",
                  cause: failure,
                },
              },
            },
      );
      expect(fixture.files.has(file)).toBe(false);
      expect(fixture.files.get(siblingFile)).toBe(`${routeMetadataLine(sibling)}\nsibling routes`);
      expect(fixture.runtime.requests).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
