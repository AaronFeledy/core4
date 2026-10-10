import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { sameRealpath } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "canonical-root-lifecycle.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 3000,
      protocol: "http",
      name: "http",
      publication: { hostPort: 3000 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const acceleratedPlanFor = (root: AbsolutePath): AppPlan => {
  const id = AppId.make("canonical-sync");
  const app = { kind: "user" as const, id, root };
  const session: FileSyncSessionSpec = {
    app,
    service: web.name,
    mountKey: "app-mount",
    source: root,
    target: { _tag: "volume", name: "canonical-sync-web-app-mount", path: PortablePath.make("/app") },
    mode: "two-way-safe",
    excludes: [],
  };
  return {
    id,
    name: "canonical-sync",
    slug: "canonical-sync",
    root,
    provider: providerId,
    services: {
      [web.name]: {
        ...web,
        appMount: {
          source: root,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
        },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [{ engineId: "mutagen", session }],
    metadata,
    extensions: {},
  };
};

const listed = (spec: FileSyncSessionSpec, ref = FileSyncSessionRef.make("legacy")): FileSyncSessionInfo => ({
  ref,
  app: spec.app,
  service: spec.service,
  mountKey: spec.mountKey,
  spec,
  status: "running",
  lastUpdatedAt: DateTime.makeUnsafe("2026-05-28T00:00:00Z"),
});

const makeTrackingEngine = (initial: ReadonlyArray<FileSyncSessionInfo> = []) => {
  const sessions = [...initial];
  const calls: string[] = [];
  const engine = {
    ...TestFileSyncEngine,
    id: "mutagen",
    isAvailable: Effect.succeed(true),
    sessionsPersistAcrossProcesses: true,
    listSessions: (filter: FileSyncSessionFilter) =>
      Effect.sync(() =>
        sessions.filter(
          (info) =>
            (filter.app === undefined ||
              (info.app.kind === filter.app.kind &&
                info.app.id === filter.app.id &&
                sameRealpath(info.app.root, filter.app.root))) &&
            (filter.service === undefined || info.service === filter.service) &&
            (filter.mountKey === undefined || info.mountKey === filter.mountKey),
        ),
      ),
    createSession: (spec: FileSyncSessionSpec) =>
      Effect.sync(() => {
        calls.push("create");
        const ref = FileSyncSessionRef.make(`created-${sessions.length}`);
        sessions.push(listed(spec, ref));
        return ref;
      }),
    resumeSession: () =>
      Effect.sync(() => {
        calls.push("resume");
      }),
    flushSession: () =>
      Effect.sync(() => {
        calls.push("flush");
      }),
    terminateSession: (ref: FileSyncSessionRef) =>
      Effect.sync(() => {
        calls.push("terminate");
        const index = sessions.findIndex((entry) => entry.ref === ref);
        if (index >= 0) sessions.splice(index, 1);
      }),
  };
  return { engine, sessions, calls };
};

const targetFor = (plannedApp: AppPlan) => ({
  plan: plannedApp,
  root: plannedApp.root,
  app: { kind: "user" as const, id: plannedApp.id, root: plannedApp.root },
});

const runStart = (harness: ReturnType<typeof makeHarness>, plannedApp: AppPlan) =>
  Effect.runPromise(startApp({}, targetFor(plannedApp)).pipe(Effect.provide(harness.layer)));

const runStop = (harness: ReturnType<typeof makeHarness>, plannedApp: AppPlan) =>
  Effect.runPromise(stopAppForTarget({}, targetFor(plannedApp)).pipe(Effect.provide(harness.layer)));

const runDestroy = (harness: ReturnType<typeof makeHarness>, plannedApp: AppPlan) =>
  Effect.runPromise(destroyAppForTarget({}, targetFor(plannedApp)).pipe(Effect.provide(harness.layer)));

describe("canonical-root file-sync lifecycle", () => {
  test("start, stop, then start again records sessions on the canonical root", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const plannedApp = acceleratedPlanFor(canonical);
    const { engine, sessions } = makeTrackingEngine();
    const harness = makeHarness({
      plannedApp,
      fileSync: engine,
      appliedFileSyncState: "accelerated",
    });
    try {
      await runStart(harness, plannedApp);
      expect(sessions).toHaveLength(1);
      await runStop(harness, plannedApp);
      expect(sessions).toHaveLength(0);
      await runStart(harness, plannedApp);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.spec.app.root).toBe(canonical);
      expect(sessions[0]?.spec.source).toBe(canonical);
    } finally {
      await rm(canonical, { recursive: true, force: true });
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });

  test("start, stop, then start again heals a legacy short-path session and applied record", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    const plannedApp = acceleratedPlanFor(canonical);
    const plannedSession = plannedApp.fileSync[0]?.session;
    if (plannedSession === undefined) throw new Error("Expected a planned file-sync session");
    const legacySession = {
      ...plannedSession,
      app: { ...plannedSession.app, root: legacy },
      source: legacy,
    };
    const { engine, sessions, calls } = makeTrackingEngine([listed(legacySession)]);
    const harness = makeHarness({
      plannedApp,
      fileSync: engine,
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [legacySession],
    });
    try {
      await runStart(harness, plannedApp);
      expect(calls.includes("create")).toBe(false);
      expect(sessions).toHaveLength(1);
      await runStop(harness, plannedApp);
      expect(sessions).toHaveLength(0);
      await runStart(harness, plannedApp);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.spec.app.root).toBe(canonical);
      expect(sessions[0]?.spec.source).toBe(canonical);
    } finally {
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });

  test("destroy succeeds for a legacy short-path session and applied record", async () => {
    const canonical = AbsolutePath.make(
      await realpath(await mkdtemp(join(tmpdir(), "lando-canonical-life-"))),
    );
    const legacy = AbsolutePath.make(`${canonical}-short`);
    await symlink(canonical, legacy);
    const plannedApp = acceleratedPlanFor(canonical);
    const plannedSession = plannedApp.fileSync[0]?.session;
    if (plannedSession === undefined) throw new Error("Expected a planned file-sync session");
    const legacySession = {
      ...plannedSession,
      app: { ...plannedSession.app, root: legacy },
      source: legacy,
    };
    const { engine, sessions } = makeTrackingEngine([listed(legacySession)]);
    const harness = makeHarness({
      plannedApp,
      fileSync: engine,
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [legacySession],
    });
    try {
      const destroyResult = await runDestroy(harness, plannedApp);
      expect(destroyResult.app).toBe("canonical-sync");
      expect(sessions).toHaveLength(0);
    } finally {
      await rm(legacy, { force: true });
      await rm(canonical, { recursive: true, force: true });
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });
});
