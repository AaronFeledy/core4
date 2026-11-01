import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PortablePath,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner, ConfigService, FileSystem, GlobalAppService } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { makeGlobalAppService } from "../../src/global-app/service.ts";
import {
  applyTreeId,
  startFileSyncTreeId,
  startHostProxyTreeId,
  startRoutesTreeId,
} from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  byTag,
  makeHarness,
  plan,
  runStart,
  startOwnedParentIds,
  web,
} from "./start-progress-topology-support.ts";

const planWithFileSync: AppPlan = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      mounts: [
        {
          type: "bind",
          role: "app",
          source: plan.root,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
          mountKey: "app-mount",
        },
      ],
    },
  },
  fileSync: [
    {
      engineId: "mutagen",
      session: {
        app: { kind: "user", id: plan.id, root: plan.root },
        service: web.name,
        mountKey: "app-mount",
        source: plan.root,
        target: { _tag: "volume", name: "test-start-web-app-mount", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [".git"],
      },
    },
  ],
};

describe("start progress topology", () => {
  test("passes resolved service secrets only through transient provider options", async () => {
    // Given
    const secretPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          environment: { PLAIN: "visible", TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" } },
        },
      },
    };
    let applied: { readonly plan: AppPlan; readonly environment: unknown } | undefined;
    const harness = makeHarness({
      plannedApp: secretPlan,
      secretStore: {
        id: "test",
        get: () => Effect.succeed("resolved-canary"),
        has: () => Effect.succeed(true),
        list: Effect.succeed(["API_TOKEN"]),
      },
      onApply: (appliedPlan, options) =>
        Effect.gen(function* () {
          const resolve = options?.resolveServiceEnvironment;
          if (resolve === undefined) throw new Error("creation resolver missing");
          const entries = yield* Effect.forEach(Object.values(appliedPlan.services), (service) =>
            resolve(service).pipe(Effect.map((env) => [service.name, env] as const)),
          );
          applied = { plan: appliedPlan, environment: Object.fromEntries(entries) };
        }),
    });

    // When
    await runStart(harness, secretPlan);

    // Then
    expect(applied?.environment).toMatchObject({ web: { PLAIN: "visible", TOKEN: "resolved-canary" } });
    expect(applied?.plan.services[web.name]?.environment).toEqual({
      PLAIN: "visible",
      TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" },
    });
    expect(JSON.stringify(applied?.plan)).not.toContain("resolved-canary");
  });

  test("skips start-owned trees when global, host-proxy, file-sync, and routes are inapplicable", async () => {
    const harness = makeHarness();
    await runStart(harness);

    expect(startOwnedParentIds(harness.events)).toEqual([]);
    expect(byTag(harness.events, "task.tree.start").map((event) => event.parentId)).toEqual([
      applyTreeId(String(plan.id)),
    ]);
    expect(byTag(harness.events, "task.tree.complete").map((event) => event.parentId)).toEqual([
      applyTreeId(String(plan.id)),
    ]);
  });

  test("emits a routes tree only when routes exist and settles it after apply", async () => {
    const routedPlan: AppPlan = {
      ...plan,
      routes: [
        {
          hostname: "web.test-start.lndo.site",
          priority: 2,
          scheme: "https",
          service: web.name,
          endpoint: 3000,
          backend: { service: web.name, protocol: "http", port: 3000 },
        },
      ],
    };
    const owned: import("@lando/sdk/services").ServiceRuntimeInfo[] = [];
    const harness = makeHarness({
      plannedApp: routedPlan,
      providerOverrides: { list: (filter) => Effect.succeed(filter.app === "global" ? owned : []) },
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: routedPlan.provider,
          status: "running",
          publications: { status: "unknown" },
        }),
      onApply: (applied) => {
        if (applied.id === "global")
          owned.push(
            ...Object.values(applied.services).map((service) => ({
              app: applied.id,
              appRoot: applied.root,
              service: service.name,
              providerId: applied.provider,
              containerId: `owned-${service.name}`,
              status: "running",
              publications: { status: "unknown" as const },
            })),
          );
      },
    });
    const dependencies = await Effect.runPromise(
      Effect.all({ config: ConfigService, fileSystem: FileSystem }).pipe(Effect.provide(harness.layer)),
    );
    const globalRoot = AbsolutePath.make(join(harness.userDataRoot, "global"));
    await mkdir(globalRoot);
    await writeFile(join(globalRoot, ".lando.yml"), "services:\n  test:\n    type: node\n");
    const config: typeof ConfigService.Service = {
      ...dependencies.config,
      load: dependencies.config.load.pipe(
        Effect.map((value) => ({ ...value, userDataRoot: AbsolutePath.make(harness.userDataRoot) })),
      ),
      get: (key) => config.load.pipe(Effect.map((value) => value[key])),
    };
    const global = makeGlobalAppService(config, dependencies.fileSystem);
    const globalPlan: AppPlan = {
      ...plan,
      id: AppId.make("global"),
      name: "global",
      root: globalRoot,
      services: { [ServiceName.make("test")]: { ...web, name: ServiceName.make("test") } },
      routes: [],
    };
    await Effect.runPromise(
      startApp(
        {},
        {
          plan: routedPlan,
          root: routedPlan.root,
          app: { kind: "user", id: routedPlan.id, root: routedPlan.root },
        },
      ).pipe(
        Effect.provideService(GlobalAppService, global),
        Effect.provideService(AppPlanner, {
          plan: (landofile) =>
            Effect.succeed({
              ...(landofile.document.name === "global" ? globalPlan : routedPlan),
              valueModel: 1 as const,
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );

    const parentId = startRoutesTreeId(String(plan.id));
    const treeStarts = byTag(harness.events, "task.tree.start").filter((event) =>
      [applyTreeId(String(plan.id)), parentId].includes(event.parentId),
    );
    expect(treeStarts.map((event) => event.parentId)).toEqual([applyTreeId(String(plan.id)), parentId]);
    expect(treeStarts[1]).toMatchObject({
      parentId,
      children: [startChildTaskId(parentId, "apply")],
    });
    const applyCompleteIndex = harness.events.findIndex(
      (event) => event._tag === "task.tree.complete" && event.parentId === applyTreeId(String(plan.id)),
    );
    const routesStartIndex = harness.events.findIndex(
      (event) => event._tag === "task.tree.start" && event.parentId === parentId,
    );
    expect(applyCompleteIndex).toBeGreaterThan(-1);
    expect(routesStartIndex).toBeGreaterThan(applyCompleteIndex);
    expect(
      byTag(harness.events, "task.tree.complete")
        .map((event) => event.parentId)
        .filter((id) => [applyTreeId(String(plan.id)), parentId].includes(id)),
    ).toEqual([applyTreeId(String(plan.id)), parentId]);
  });

  test("owns file-sync detail with matching tree and task ids", async () => {
    let setupComplete = false;
    let availabilityChecks = 0;
    const harness = makeHarness({
      plannedApp: planWithFileSync,
      fileSync: {
        id: "mutagen",
        displayName: "Mutagen",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "auto",
          exclusionPatterns: true,
          conflictReporting: true,
          progressReporting: true,
        },
        isAvailable: Effect.sync(() => ++availabilityChecks === 1 || setupComplete),
        setup: () =>
          Effect.sync(() => {
            setupComplete = true;
          }),
        createSession: (spec: FileSyncSessionSpec) =>
          Effect.succeed(FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`)),
        flushSession: () => Effect.void,
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: () => Effect.void,
        listSessions: () => Effect.succeed([]),
        streamEvents: () => Stream.empty,
      },
    });
    await runStart(harness, planWithFileSync);

    const parentId = startFileSyncTreeId(String(plan.id));
    const setupId = startChildTaskId(parentId, "setup");
    const tags = harness.events.map((event) => event._tag);
    const treeStart = harness.events.findIndex(
      (event) => event._tag === "task.tree.start" && event.parentId === parentId,
    );
    const taskStart = harness.events.findIndex(
      (event) => event._tag === "task.start" && event.taskId === setupId,
    );
    const detail = harness.events.findIndex(
      (event) => event._tag === "task.detail" && event.taskId === setupId,
    );
    const taskComplete = harness.events.findIndex(
      (event) => (event._tag === "task.complete" || event._tag === "task.fail") && event.taskId === setupId,
    );
    const treeComplete = harness.events.findIndex(
      (event) => event._tag === "task.tree.complete" && event.parentId === parentId,
    );
    expect(treeStart).toBeGreaterThan(-1);
    expect(taskStart).toBeGreaterThan(treeStart);
    expect(detail).toBeGreaterThan(taskStart);
    expect(taskComplete).toBeGreaterThan(detail);
    expect(treeComplete).toBeGreaterThan(taskComplete);
    expect(tags.filter((tag) => tag === "task.tree.start").length).toBeGreaterThan(1);
    expect(startOwnedParentIds(harness.events).every((id) => id === parentId)).toBe(true);
  });

  test("fails before apply when the live adapter becomes unavailable", async () => {
    let availabilityChecks = 0;
    let applied = false;
    const harness = makeHarness({
      plannedApp: planWithFileSync,
      onApply: () => {
        applied = true;
      },
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        displayName: "Mutagen",
        isAvailable: Effect.sync(() => ++availabilityChecks === 1),
        setup: () => Effect.void,
        createSession: () => Effect.die("unavailable adapter must not create a session"),
      },
    });
    await expect(runStart(harness, planWithFileSync)).rejects.toThrow(
      "Mutagen setup completed, but its live session adapter is unavailable",
    );
    expect(applied).toBe(false);
    const setupId = startChildTaskId(startFileSyncTreeId(String(plan.id)), "setup");
    const detail = byTag(harness.events, "task.detail").find(
      (event) => event.taskId === setupId && event.stream === "stderr",
    );
    expect(detail?.line).toContain("FileSyncStartError: Mutagen setup completed");
    expect(detail?.line).toContain("live session adapter is unavailable");
    expect(detail?.line).toContain("use passthrough mounts before retrying start");
    expect(byTag(harness.events, "task.fail").find((event) => event.taskId === setupId)).toMatchObject({
      summary: "File-sync adapter unavailable",
      remediation: "Enable a live file-sync adapter or use passthrough mounts before retrying start.",
    });
    expect(
      byTag(harness.events, "task.tree.complete").find(
        (event) => event.parentId === startFileSyncTreeId(String(plan.id)),
      ),
    ).toMatchObject({
      summary: "test-start file-sync failed",
      failed: 2,
    });
  });

  test("does not emit a host-proxy tree when no service is eligible", async () => {
    const harness = makeHarness();
    await runStart(harness);
    expect(
      harness.events.some(
        (event) =>
          event._tag === "task.tree.start" && event.parentId === startHostProxyTreeId(String(plan.id)),
      ),
    ).toBe(false);
  });

  test("settles the apply tree when start is interrupted after the tree opens", async () => {
    const harness = makeHarness({ applyEffect: Effect.never });
    const fiber = Effect.runFork(
      startApp({}, { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    await harness.applyTreeStarted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const parentId = applyTreeId(String(plan.id));
    expect(byTag(harness.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      children: ["web"],
    });
    expect(byTag(harness.events, "task.start").map((event) => event.taskId)).toContain("web");
    expect(byTag(harness.events, "task.fail").map((event) => event.taskId)).toContain("web");
    expect(byTag(harness.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      failed: 1,
    });
  });
});
