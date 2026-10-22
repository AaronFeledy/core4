import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { EventService, PathsService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type { AppliedTeardownEvidence } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Stream } from "effect";
import { executeGlobalTeardown } from "../../src/operations/global-teardown.ts";

test.each(["applied", "orphans", "owned", "absent"] as const)(
  "global executor brackets %s evidence and completes routes before post",
  async (kind) => {
    // Given independently recorded provider, router and event effects at an isolated root.
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "global-teardown-events-")));
    const root = AbsolutePath.make(join(dataRoot, "global"));
    const providerId = ProviderId.make("lando");
    const appId = AppId.make("global");
    const calls: string[] = [];
    const events: LandoEvent[] = [];
    const plan: AppPlan = {
      id: appId,
      name: "global",
      slug: "global",
      provider: providerId,
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
        source: "global-app",
        runtime: 4,
      },
      extensions: {},
      root,
      identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    };
    const provider = {
      ...TestRuntimeProvider,
      destroy: () =>
        Effect.sync(() => {
          calls.push("destroy");
          return { kind: "destroyed" as const };
        }),
      removeObservedService: () =>
        Effect.sync(() => {
          calls.push("orphan");
          return { kind: "removed" as const };
        }),
      cleanupOwnedResources: () =>
        Effect.sync(() => {
          calls.push("owned");
          return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 };
        }),
    };
    let evidence: AppliedTeardownEvidence;
    switch (kind) {
      case "applied":
        evidence = { kind, plan };
        break;
      case "orphans":
        evidence = {
          kind,
          groups: [
            {
              providerId,
              appId,
              services: [
                {
                  app: appId,
                  appRoot: root,
                  providerId,
                  service: ServiceName.make("web"),
                  status: "running",
                  containerId: "observed",
                },
              ],
              volumes: [],
            },
          ],
        };
        break;
      case "owned":
        evidence = {
          kind,
          ownership: [
            { appRoot: root, ownerKey: appIdentityKey("owner", root), providerId, appIds: [appId] },
          ],
        };
        break;
      case "absent":
        evidence = { kind };
        break;
      default:
        return kind satisfies never;
    }
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      Layer.succeed(
        PathsService,
        makeLandoPaths({
          userDataRoot: dataRoot,
          userCacheRoot: join(dataRoot, "cache"),
          userConfRoot: join(dataRoot, "conf"),
          systemPluginRoot: join(dataRoot, "sys"),
          env: {},
          platform: "linux",
        }),
      ),
      Layer.succeed(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([providerId]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(
        RouterService,
        RouterService.of({
          ...makeTestRouterService(),
          removeRoutes: () =>
            Effect.sync(() => {
              calls.push("routes");
            }),
        }),
      ),
      Layer.succeed(
        EventService,
        EventService.of({
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
              calls.push(event._tag);
            }),
          subscribe: () => Stream.empty,
          subscribeQueue: Effect.die("unused queue"),
          waitFor: () => Effect.never,
          waitForAny: () => Effect.never,
          query: () => Effect.succeed([]),
        }),
      ),
    );
    try {
      // When destroy intent executes the resolved evidence without reading desired config.
      const result = await Effect.runPromise(
        executeGlobalTeardown(
          {
            paths: {
              root,
              distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
              userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
            },
            provider,
            evidence,
            materialized: false,
          },
          { intent: "destroy", volumes: false, removeState: true },
        ).pipe(Effect.provide(layer)),
      );
      // Then absence stays silent; every nonempty evidence kind has the same successful bracket.
      if (kind === "absent") {
        expect(calls).toEqual([]);
        expect(result.changed).toBe(false);
      } else {
        expect(calls[0]).toBe("pre-global-destroy");
        expect(calls.indexOf("task.tree.start")).toBeGreaterThan(0);
        expect(calls.indexOf("routes")).toBeGreaterThan(calls.indexOf("task.tree.start"));
        expect(calls.at(-1)).toBe("post-global-destroy");
        expect(events[0]).toMatchObject({ evidence: kind, purge: false, app: { kind: "global", root } });
        expect(events.at(-1)).toMatchObject({ outcome: "destroyed", evidence: kind });
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
);
