import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import { ProxyError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type AppRouteOwner,
  ProviderId,
  appIdentityKey,
} from "@lando/sdk/schema";
import { PathsService, RouterService } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { TestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";

import { routeOwnerFromRoot } from "../../src/lifecycle/route-owner.ts";
import { executeTeardown } from "../../src/operations/destroy-execute.ts";
import type { TeardownPlan } from "../../src/operations/destroy-plan.ts";
import { destroyTreeId } from "../../src/operations/destroy-progress.ts";
import { haltAppRuntime, stopAppForTarget } from "../../src/operations/stop.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { layerUnavailable } from "../../src/subsystems/proxy/api.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness as makeDestroyHarness } from "./destroy-progress-topology-support.ts";
import { byTag, makeHarness, plan } from "./start-progress-topology-support.ts";

const recordingRouter = (calls: string[]) => ({
  ...TestRouterService,
  setup: () => Effect.die("route withdrawal must not set up the router"),
  prepare: () => Effect.die("route withdrawal must not prepare the router"),
  applyRoutes: () => Effect.die("route withdrawal must not apply routes"),
  removeRoutes: (owner: AppRouteOwner) => Effect.sync(() => void calls.push(`remove:${owner.ownerKey}`)),
});

const withBase = async (use: (base: string) => Promise<void>) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-stop-route-withdrawal-")));
  try {
    await use(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
};

const appAt = (root: AbsolutePath): AppPlan => ({
  ...plan,
  root,
  identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
});

describe("public stop route withdrawal", () => {
  test("running stop withdraws the plan owner's routes after destroying containers", async () => {
    // Given a running applied app
    const calls: string[] = [];
    const harness = makeHarness({ onDestroy: () => void calls.push("destroy") });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

    // When the public stop runs
    await Effect.runPromise(
      stopAppForTarget({}, target).pipe(
        Effect.provideService(RouterService, recordingRouter(calls)),
        Effect.provide(harness.layer),
      ),
    );

    // Then containers go first and routes are withdrawn once by the canonical owner key
    expect(calls).toEqual(["destroy", `remove:${appIdentityKey("owner", plan.root)}`]);
  });

  test("halting the runtime for restart or rebuild retains published routes", async () => {
    // Given a running applied app
    const calls: string[] = [];
    const harness = makeHarness({ onDestroy: () => void calls.push("destroy") });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

    // When the runtime is halted
    await Effect.runPromise(
      haltAppRuntime({}, target).pipe(
        Effect.provideService(RouterService, recordingRouter(calls)),
        Effect.provide(harness.layer),
      ),
    );

    // Then containers are destroyed and no route definition is withdrawn
    expect(calls).toEqual(["destroy"]);
  });

  test.each(["absent", "orphans"] as const)(
    "stop with %s evidence withdraws by the canonical-root owner key",
    async (kind) => {
      await withBase(async (base) => {
        // Given an app root whose provider holds no applied plan
        const root = AbsolutePath.make(join(base, "app"));
        await mkdir(root);
        const desired = appAt(root);
        const calls: string[] = [];
        const harness = makeHarness({
          plannedApp: desired,
          onDestroy: () => void calls.push("destroy"),
          resolveTeardownEvidence: () => Effect.succeed(kind === "absent" ? { kind } : { kind, groups: [] }),
        });

        // When the public stop runs against the desired Landofile
        await Effect.runPromise(
          stopAppForTarget(
            {},
            {
              plan: desired,
              root,
              app: { kind: "user", id: desired.id, root },
              landofile: literalTestLandofile({ name: desired.name, services: {} }, root),
            },
          ).pipe(
            Effect.provideService(RouterService, recordingRouter(calls)),
            Effect.provideService(
              PathsService,
              makeLandoPaths({ userDataRoot: base, env: {}, platform: "linux" }),
            ),
            Effect.provide(harness.layer),
            Effect.provide(BunFileSystem.layer),
          ),
        );

        // Then nothing is destroyed and the root-derived definition is withdrawn
        expect(calls).toEqual([`remove:${routeOwnerFromRoot(desired.id, root).ownerKey}`]);
      });
    },
  );

  test("an unavailable router warns and lets stop succeed", async () => {
    // Given no selectable router
    const harness = makeHarness();
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

    // When the public stop runs
    const result = await Effect.runPromise(
      stopAppForTarget({}, target).pipe(Effect.provide(layerUnavailable), Effect.provide(harness.layer)),
    );

    // Then stop succeeds with one warning
    expect(result.outcome).toBe("stopped");
    expect(byTag(harness.events, "message.warn")).toHaveLength(1);
  });

  test("a failing router fails stop after host workers are cleaned", async () => {
    await withBase(async (base) => {
      // Given a running app with host worker state and a router that cannot withdraw
      const paths = makeLandoPaths({ userDataRoot: base, env: {}, platform: "linux" });
      const root = AbsolutePath.make(join(base, "app"));
      await mkdir(root);
      const applied = appAt(root);
      const app = { kind: "user" as const, id: applied.id, root };
      const directories = [
        paths.hostProxyRunDir(app.id, root),
        paths.agentRelayRunDir("ssh", app.id, root),
        paths.agentRelayRunDir("gpg", app.id, root),
      ];
      for (const directory of directories) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "credentials"), "stale", { mode: 0o600 });
      }
      const failure = new ProxyError({
        proxyId: "test",
        message: "route withdrawal failed",
        remediation: "Repair route storage.",
      });

      // When the public stop runs
      const result = await Effect.runPromise(
        stopAppForTarget({}, { plan: applied, root, app }).pipe(
          Effect.provideService(RouterService, {
            ...TestRouterService,
            removeRoutes: () => Effect.fail(failure),
          }),
          Effect.provideService(PathsService, paths),
          Effect.provide(makeHarness({ plannedApp: applied, appliedPlans: [applied] }).layer),
          Effect.provide(BunFileSystem.layer),
          Effect.result,
        ),
      );

      // Then the router failure surfaces and worker state is gone
      expect(result).toMatchObject({ _tag: "Failure", failure });
      for (const directory of directories)
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("destroy route withdrawal without an applied plan", () => {
  test("orphan destroy withdraws by the canonical-root owner key and completes the routes task", async () => {
    // Given orphaned runtime evidence and no applied plan for a canonical app root
    const root = AbsolutePath.make("/srv/apps/orphaned");
    const appId = AppId.make("orphaned");
    const calls: string[] = [];
    const harness = makeDestroyHarness();
    const teardown: TeardownPlan = {
      evidence: "orphans",
      root,
      name: "orphaned",
      refs: [{ kind: "user", id: appId, root }],
      applied: undefined,
      authored: undefined,
      retained: undefined,
      target: undefined,
      groups: [{ appId, providerId: ProviderId.make("lando"), services: [], volumes: [] }],
      inventory: [],
      snapshots: [],
      followUpOrphans: false,
      options: {},
    };

    // When destroy executes
    await Effect.runPromise(
      executeTeardown(teardown).pipe(
        Effect.provideService(RouterService, recordingRouter(calls)),
        Effect.provide(harness.layer),
      ),
    );

    // Then the root-owned definition is withdrawn under a completed routes task
    expect(calls).toEqual([`remove:${appIdentityKey("owner", root)}`]);
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(
      startChildTaskId(destroyTreeId(String(appId)), "routes"),
    );
  });
});
