import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Fiber, Scope } from "effect";

import { containerHostConfigFragment } from "@lando/container-runtime/plan";
import {
  EventError,
  FileSyncStartError,
  FileSyncStopError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  AbsoluteContainerPath,
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
  type ServicePlan,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { requireNoPendingAcceleratedStart } from "../../src/operations/accelerated-start-journal.ts";
import { resolveFileSyncMountPlan } from "../../src/operations/file-sync-plan.ts";
import { startFileSyncSessions } from "../../src/operations/start-file-sync.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const acceleratedService: ServicePlan = {
  ...web,
  appMount: {
    source: plan.root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    excludes: [],
    includes: [],
  },
  mounts: [
    {
      type: "bind",
      source: "/host/extra",
      target: PortablePath.make("/extra"),
      readOnly: false,
      realization: "accelerated",
    },
  ],
};

const acceleratedPlan: AppPlan = {
  ...plan,
  services: { [web.name]: acceleratedService },
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
        excludes: [],
      },
    },
    {
      engineId: "mutagen",
      session: {
        app: { kind: "user", id: plan.id, root: plan.root },
        service: web.name,
        mountKey: "mount-0",
        source: AbsolutePath.make("/host/extra"),
        target: { _tag: "volume", name: "test-start-web-mount-0", path: PortablePath.make("/extra") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
};

describe("file-sync mount realization before provider apply", () => {
  test("unavailable adapter gives provider host binds and no empty sync-backed volume", async () => {
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      fileSync: { ...TestFileSyncEngine, isAvailable: Effect.succeed(false) },
      onApply: (next) => applied.push(next),
    });
    await runStart(harness, acceleratedPlan);

    expect(
      harness.events.filter((event) => event._tag === "message.warn").map((event) => event.body),
    ).toEqual(["Accelerated file sync is unavailable. Lando is using ordinary bind mounts for this app."]);
    expect(applied).toHaveLength(1);
    const providerPlan = applied[0];
    if (providerPlan === undefined) throw new Error("Provider did not receive a plan");
    expect(providerPlan.fileSync).toEqual([]);
    const service = providerPlan.services[web.name];
    if (service === undefined) throw new Error("App service was not planned");
    expect(service.appMount?.realization).toBe("passthrough");
    expect(service.mounts[0]?.realization).toBe("passthrough");
    const binds = containerHostConfigFragment(providerPlan, service).Binds ?? [];
    expect(binds).toContain(`${plan.root}:/app`);
    expect(binds).toContain("/host/extra:/extra");
    expect((binds as string[]).some((bind) => bind.includes("app-mount:/app"))).toBe(false);
  });

  test("available selected engine downgrades every accelerated mount when any session plans another engine", async () => {
    const applied: AppPlan[] = [];
    const [appEntry, extraEntry] = acceleratedPlan.fileSync;
    if (appEntry === undefined || extraEntry === undefined) {
      throw new Error("Accelerated fixture has incomplete file-sync sessions");
    }
    const mixedPlan: AppPlan = {
      ...acceleratedPlan,
      fileSync: [appEntry, { ...extraEntry, engineId: "other" }],
    };
    const harness = makeHarness({
      plannedApp: mixedPlan,
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(true) },
      onApply: (next) => applied.push(next),
    });
    await runStart(harness, mixedPlan);

    expect(applied).toHaveLength(1);
    const providerPlan = applied[0];
    if (providerPlan === undefined) throw new Error("Provider did not receive a plan");
    expect(providerPlan.fileSync).toEqual([]);
    const service = providerPlan.services[web.name];
    if (service === undefined) throw new Error("App service was not planned");
    expect(service.appMount?.realization).toBe("passthrough");
    expect(service.mounts[0]?.realization).toBe("passthrough");
    expect(containerHostConfigFragment(providerPlan, service).Binds).toContain(`${plan.root}:/app`);
  });

  test("global Traefik dynamic config remains a host bind when sync is available", async () => {
    const traefik = ServiceName.make("traefik");
    const globalPlan: AppPlan = {
      ...plan,
      id: AppId.make("global"),
      name: "global",
      slug: "global",
      services: {
        [traefik]: {
          ...web,
          name: traefik,
          appMount: undefined,
          mounts: [
            {
              type: "bind",
              source: "/host/lando/global/proxy-traefik/dynamic",
              target: PortablePath.make("/etc/traefik/dynamic"),
              readOnly: false,
              realization: "accelerated",
            },
          ],
        },
      },
    };
    const realized = await Effect.runPromise(
      resolveFileSyncMountPlan(globalPlan).pipe(
        Effect.provideService(FileSyncEngine, { ...TestFileSyncEngine, isAvailable: Effect.succeed(true) }),
      ),
    );
    expect(realized.fileSync).toEqual([]);
    const service = realized.services[traefik];
    if (service === undefined) throw new Error("Global Traefik was not planned");
    expect(service.mounts[0]?.realization).toBe("passthrough");
    expect(containerHostConfigFragment(realized, service).Binds).toContain(
      "/host/lando/global/proxy-traefik/dynamic:/etc/traefik/dynamic",
    );
  });

  test("available adapter downgrades accelerated mounts with missing, duplicate, or orphan sessions", async () => {
    const [appEntry, extraEntry] = acceleratedPlan.fileSync;
    if (appEntry === undefined || extraEntry === undefined) {
      throw new Error("Accelerated fixture has incomplete file-sync sessions");
    }
    const cases: ReadonlyArray<{ name: string; fileSync: AppPlan["fileSync"] }> = [
      { name: "empty", fileSync: [] },
      { name: "missing mount-0", fileSync: [appEntry] },
      { name: "duplicate app-mount", fileSync: [appEntry, appEntry] },
      {
        name: "orphan mount key",
        fileSync: [appEntry, { ...extraEntry, session: { ...extraEntry.session, mountKey: "mount-99" } }],
      },
      {
        name: "global app identity",
        fileSync: [
          appEntry,
          {
            ...extraEntry,
            session: {
              ...extraEntry.session,
              app: { kind: "global", id: plan.id, root: plan.root },
            },
          },
        ],
      },
      {
        name: "permission override",
        fileSync: [
          appEntry,
          {
            ...extraEntry,
            session: { ...extraEntry.session, permissions: { mode: "0644" } },
          },
        ],
      },
      {
        name: "wrong source",
        fileSync: [
          appEntry,
          { ...extraEntry, session: { ...extraEntry.session, source: AbsolutePath.make("/host/wrong") } },
        ],
      },
      {
        name: "wrong mode",
        fileSync: [appEntry, { ...extraEntry, session: { ...extraEntry.session, mode: "one-way-safe" } }],
      },
      {
        name: "wrong excludes",
        fileSync: [appEntry, { ...extraEntry, session: { ...extraEntry.session, excludes: ["vendor"] } }],
      },
      {
        name: "wrong volume",
        fileSync: [
          appEntry,
          {
            ...extraEntry,
            session: {
              ...extraEntry.session,
              target: { _tag: "volume", name: "wrong-volume", path: PortablePath.make("/extra") },
            },
          },
        ],
      },
      {
        name: "wrong target path",
        fileSync: [
          appEntry,
          {
            ...extraEntry,
            session: {
              ...extraEntry.session,
              target: {
                _tag: "volume",
                name: "test-start-web-mount-0",
                path: PortablePath.make("/wrong"),
              },
            },
          },
        ],
      },
    ];
    for (const { name, fileSync } of cases) {
      const resolved = await Effect.runPromise(
        resolveFileSyncMountPlan({ ...acceleratedPlan, fileSync }).pipe(
          Effect.provideService(FileSyncEngine, {
            ...TestFileSyncEngine,
            id: "mutagen",
            isAvailable: Effect.succeed(true),
          }),
        ),
      );
      expect(resolved.fileSync, name).toEqual([]);
      expect(resolved.services[web.name]?.appMount?.realization, name).toBe("passthrough");
      expect(resolved.services[web.name]?.mounts[0]?.realization, name).toBe("passthrough");
    }
  });

  test("a plan without accelerated mounts drops orphan file-sync sessions", async () => {
    const resolved = await Effect.runPromise(
      resolveFileSyncMountPlan({ ...plan, fileSync: acceleratedPlan.fileSync }),
    );
    expect(resolved.fileSync).toEqual([]);
    expect(resolved.services).toBe(plan.services);
  });

  test("a duplicate bind mount at the app target needs only the app-mount session", async () => {
    const appEntry = acceleratedPlan.fileSync[0];
    if (appEntry === undefined) throw new Error("Accelerated fixture has no app-mount session");
    const duplicatePlan: AppPlan = {
      ...acceleratedPlan,
      services: {
        [web.name]: {
          ...acceleratedService,
          mounts: [
            {
              type: "bind",
              source: plan.root,
              target: PortablePath.make("/app"),
              readOnly: false,
              realization: "accelerated",
            },
          ],
        },
      },
      fileSync: [appEntry],
    };
    const resolved = await Effect.runPromise(
      resolveFileSyncMountPlan(duplicatePlan).pipe(
        Effect.provideService(FileSyncEngine, {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
        }),
      ),
    );
    expect(resolved).toBe(duplicatePlan);
  });

  test("available injected adapter retains accelerated publication and sync sessions", async () => {
    const resolved = await Effect.runPromise(
      resolveFileSyncMountPlan(acceleratedPlan).pipe(
        Effect.provideService(FileSyncEngine, {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
        }),
      ),
    );
    expect(resolved).toBe(acceleratedPlan);
    expect(resolved.fileSync).toHaveLength(2);
    expect(resolved.services[web.name]?.appMount?.realization).toBe("accelerated");
    expect(resolved.services[web.name]?.mounts[0]?.realization).toBe("accelerated");
  });
});

describe("file-sync start engine identity", () => {
  const events = { publish: () => Effect.void };

  test("nonempty session plan fails with a tagged error when no engine is selected", async () => {
    const result = await Effect.runPromise(Effect.either(startFileSyncSessions(acceleratedPlan, events)));
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") throw new Error("Expected file-sync start to fail");
    expect(result.left).toBeInstanceOf(FileSyncStartError);
    expect(result.left).toMatchObject({
      engineId: "mutagen",
      message: expect.stringContaining("No file-sync engine is selected"),
      remediation: expect.stringContaining("ordinary bind mounts"),
    });
  });

  test("nonempty session plan rejects a different engine before invoking it", async () => {
    const wrongEngine = {
      ...TestFileSyncEngine,
      id: "other",
      isAvailable: Effect.die("wrong engine must not be probed"),
      listSessions: () => Effect.die("wrong engine must not list sessions"),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(acceleratedPlan, events).pipe(
          Effect.provideService(FileSyncEngine, wrongEngine),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") throw new Error("Expected file-sync start to fail");
    expect(result.left).toBeInstanceOf(FileSyncStartError);
    expect(result.left).toMatchObject({
      engineId: "mutagen",
      message: expect.stringContaining('Selected file-sync engine "other"'),
      remediation: expect.stringContaining("ordinary bind mounts"),
    });
  });
});

describe("file-sync session reconciliation", () => {
  const events = { publish: () => Effect.void };
  const entry = acceleratedPlan.fileSync[0];
  if (entry === undefined) throw new Error("Missing planned file-sync session");
  const singleSessionPlan: AppPlan = { ...acceleratedPlan, fileSync: [entry] };
  const ref = FileSyncSessionRef.make("prior-app-mount");
  const listed = (
    spec = entry.session,
    status: FileSyncSessionInfo["status"] = "running",
  ): FileSyncSessionInfo => ({
    ref,
    app: spec.app,
    service: spec.service,
    mountKey: spec.mountKey,
    spec,
    status,
    lastUpdatedAt: DateTime.unsafeMake("2026-05-28T00:00:00Z"),
  });

  test("rejects duplicate sessions without resuming, flushing, or terminating either", async () => {
    const calls: string[] = [];
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () =>
        Effect.succeed([listed(), { ...listed(), ref: FileSyncSessionRef.make("duplicate") }]),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(FileSyncStartError);
      expect(result.left.message).toContain("Multiple file-sync sessions");
      expect(result.left.remediation).toContain("untouched");
    }
    expect(calls).toEqual([]);
  });

  test("rejects full-spec drift without changing the existing session", async () => {
    const drifted = [
      { ...entry.session, source: AbsolutePath.make("/wrong") },
      { ...entry.session, mode: "one-way-safe" as const },
      { ...entry.session, excludes: ["vendor"] },
      { ...entry.session, permissions: { mode: "0644" } },
      {
        ...entry.session,
        target: { _tag: "volume" as const, name: "wrong", path: PortablePath.make("/app") },
      },
      { ...entry.session, app: { ...entry.session.app, kind: "global" as const } },
    ];
    for (const spec of drifted) {
      const calls: string[] = [];
      const engine = {
        ...TestFileSyncEngine,
        id: "mutagen",
        listSessions: () => Effect.succeed([listed(spec)]),
        resumeSession: () => Effect.sync(() => calls.push("resume")),
        flushSession: () => Effect.sync(() => calls.push("flush")),
        terminateSession: () => Effect.sync(() => calls.push("terminate")),
      };
      const result = await Effect.runPromise(
        Effect.either(
          startFileSyncSessions(singleSessionPlan, events).pipe(
            Effect.provideService(FileSyncEngine, engine),
          ),
        ),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("FileSyncDriftError");
        expect(result.left.remediation).toContain("untouched");
      }
      expect(calls).toEqual([]);
    }
  });

  test("flushes a resumed paused session before reporting ready", async () => {
    const calls: string[] = [];
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([listed({ ...entry.session }, "paused")]),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      pauseSession: () => Effect.sync(() => calls.push("pause")),
    };
    await Effect.runPromise(
      startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
    );
    expect(calls).toEqual(["resume", "flush"]);
  });

  test("pauses a resumed session when blocking flush fails", async () => {
    const calls: string[] = [];
    const failure = new FileSyncStartError({ engineId: "mutagen", message: "flush failed" });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([listed(entry.session, "paused")]),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.fail(failure),
      pauseSession: () => Effect.sync(() => calls.push("pause")),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBe(failure);
    expect(calls).toEqual(["resume", "pause"]);
  });

  test("leaves an errored existing session untouched", async () => {
    const calls: string[] = [];
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([listed(entry.session, "errored")]),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("FileSyncStartError");
    expect(calls).toEqual([]);
  });

  test("terminates a newly created session when blocking flush fails", async () => {
    const calls: string[] = [];
    const failure = new FileSyncStartError({ engineId: "mutagen", message: "initial flush failed" });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([]),
      createSession: () =>
        Effect.sync(() => {
          calls.push("create");
          return ref;
        }),
      flushSession: () => Effect.sync(() => calls.push("flush")).pipe(Effect.zipRight(Effect.fail(failure))),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBe(failure);
    expect(calls).toEqual(["create", "flush", "terminate"]);
  });
  test("reports unmanaged flush and terminate failures together", async () => {
    const startupFailure = new FileSyncStartError({ engineId: "mutagen", message: "flush failed" });
    const cleanupFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: ref,
      message: "terminate failed",
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([]),
      createSession: () => Effect.succeed(ref),
      flushSession: () => Effect.fail(startupFailure),
      terminateSession: () => Effect.fail(cleanupFailure),
    };
    const exit = await Effect.runPromise(
      Effect.exit(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Array.from(Cause.failures(exit.cause))).toEqual([startupFailure, cleanupFailure]);
    }
  });

  test("reports unmanaged resumed-session flush and pause failures together", async () => {
    const startupFailure = new FileSyncStartError({ engineId: "mutagen", message: "flush failed" });
    const cleanupFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: ref,
      message: "pause failed",
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([listed(entry.session, "paused")]),
      flushSession: () => Effect.fail(startupFailure),
      pauseSession: () => Effect.fail(cleanupFailure),
    };
    const exit = await Effect.runPromise(
      Effect.exit(
        startFileSyncSessions(singleSessionPlan, events).pipe(Effect.provideService(FileSyncEngine, engine)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Array.from(Cause.failures(exit.cause))).toEqual([startupFailure, cleanupFailure]);
    }
  });

  test("keeps a reused persistent running session after its managed handle closes", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([listed()]),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    await Effect.runPromise(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(calls).toEqual(["flush"]);
  });

  test("keeps a newly created persistent session after its managed handle closes", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([]),
      createSession: () =>
        Effect.sync(() => {
          calls.push("create");
          return ref;
        }),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    await Effect.runPromise(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(calls).toEqual(["create", "flush"]);
  });

  test("keeps a reused persistent running session when a later flush fails", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const failure = new FileSyncStartError({ engineId: "mutagen", message: "later flush failed" });
    const [first, second] = acceleratedPlan.fileSync;
    if (first === undefined || second === undefined) throw new Error("Missing planned sessions");
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: ({ mountKey }: { readonly mountKey?: string | undefined }) =>
        Effect.succeed(mountKey === first.session.mountKey ? [listed()] : []),
      createSession: () => Effect.succeed(FileSyncSessionRef.make("created")),
      flushSession: (session: FileSyncSessionRef) =>
        session === ref ? Effect.sync(() => calls.push("flush reused")) : Effect.fail(failure),
      terminateSession: (session: FileSyncSessionRef) =>
        Effect.sync(() => calls.push(`terminate ${session}`)),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(acceleratedPlan, events, { scope }).pipe(
          Effect.provideService(FileSyncEngine, engine),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBe(failure);
    expect(calls).toEqual(["flush reused", "terminate created"]);
  });

  test("preserves tagged startup and persistent cleanup failures", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const startupFailure = new FileSyncStartError({ engineId: "mutagen", message: "flush failed" });
    const cleanupFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: ref,
      message: "terminate failed",
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([]),
      createSession: () => Effect.succeed(ref),
      flushSession: () => Effect.fail(startupFailure),
      terminateSession: () => Effect.fail(cleanupFailure),
    };
    const exit = await Effect.runPromise(
      Effect.exit(
        startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
          Effect.provideService(FileSyncEngine, engine),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Array.from(Cause.failures(exit.cause))).toEqual([startupFailure, cleanupFailure]);
    }
  });

  test("terminates a new persistent session if startup is interrupted during flush", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    let reachedFlush: () => void = () => undefined;
    const flushing = new Promise<void>((resolve) => {
      reachedFlush = resolve;
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([]),
      createSession: () =>
        Effect.sync(() => {
          calls.push("create");
          return ref;
        }),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
          reachedFlush();
        }).pipe(Effect.zipRight(Effect.never)),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const fiber = Effect.runFork(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await flushing;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["create", "flush", "terminate"]);
  });

  test("tracks a new persistent session before honoring an acquisition-time interrupt", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    let enteredCreate: () => void = () => undefined;
    const creating = new Promise<void>((resolve) => {
      enteredCreate = resolve;
    });
    let finishCreate: () => void = () => undefined;
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([]),
      createSession: () =>
        Effect.async<FileSyncSessionRef, FileSyncStartError>((resume) => {
          calls.push("create");
          finishCreate = () => resume(Effect.succeed(ref));
          enteredCreate();
        }),
      flushSession: () => Effect.never,
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const fiber = Effect.runFork(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await creating;
    const interrupting = Effect.runPromise(Fiber.interrupt(fiber));
    finishCreate();
    const exit = await interrupting;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["create", "terminate"]);
  });

  test("terminates a reused ephemeral session if its flush is interrupted", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    let reachedFlush: () => void = () => undefined;
    const flushing = new Promise<void>((resolve) => {
      reachedFlush = resolve;
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: false,
      listSessions: () => Effect.succeed([listed()]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
          reachedFlush();
        }).pipe(Effect.zipRight(Effect.never)),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const fiber = Effect.runFork(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await flushing;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["flush", "terminate"]);
  });

  test("managed scope close reports all ephemeral pause and terminate failures", async () => {
    const scope = await Effect.runPromise(Scope.make());
    const calls: string[] = [];
    const second = acceleratedPlan.fileSync[1];
    if (second === undefined) throw new Error("Missing second planned session");
    const otherRef = FileSyncSessionRef.make("prior-extra-mount");
    const pauseFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: ref,
      message: "pause failed",
    });
    const terminateFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: otherRef,
      message: "terminate failed",
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: false,
      listSessions: ({ mountKey }: { readonly mountKey?: string | undefined }) =>
        Effect.succeed(
          mountKey === entry.session.mountKey
            ? [listed(entry.session, "paused")]
            : [{ ...listed(second.session), ref: otherRef }],
        ),
      resumeSession: () => Effect.void,
      flushSession: () => Effect.void,
      pauseSession: () =>
        Effect.sync(() => {
          calls.push("pause");
        }).pipe(Effect.zipRight(Effect.fail(pauseFailure))),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }).pipe(Effect.zipRight(Effect.fail(terminateFailure))),
    };
    await Effect.runPromise(
      startFileSyncSessions(acceleratedPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    const exit = await Effect.runPromise(Effect.exit(Scope.close(scope, Exit.void)));
    expect(calls.sort()).toEqual(["pause", "terminate"]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const defects = Array.from(Cause.defects(exit.cause));
      expect(defects).toHaveLength(2);
      expect(defects).toContain(pauseFailure);
      expect(defects).toContain(terminateFailure);
    }
  });

  test("terminates a reused ephemeral running session when its managed handle closes", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: false,
      listSessions: () => Effect.succeed([listed()]),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    await Effect.runPromise(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(calls).toEqual(["flush", "terminate"]);
  });

  test("keeps a resumed persistent session running after managed handle close", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: () => Effect.succeed([listed(entry.session, "paused")]),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      pauseSession: () => Effect.sync(() => calls.push("pause")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    await Effect.runPromise(
      startFileSyncSessions(singleSessionPlan, events, { scope }).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(calls).toEqual(["resume", "flush"]);
  });

  test("re-pauses a reused persistent session when a later startup step fails", async () => {
    const calls: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const failure = new FileSyncStartError({ engineId: "mutagen", message: "create failed" });
    const [first, second] = acceleratedPlan.fileSync;
    if (first === undefined || second === undefined) throw new Error("Missing planned sessions");
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      sessionsPersistAcrossProcesses: true,
      listSessions: ({ mountKey }: { readonly mountKey?: string | undefined }) =>
        Effect.succeed(mountKey === first.session.mountKey ? [listed(entry.session, "paused")] : []),
      resumeSession: () => Effect.sync(() => calls.push("resume")),
      flushSession: () => Effect.sync(() => calls.push("flush")),
      createSession: () => Effect.fail(failure),
      pauseSession: () => Effect.sync(() => calls.push("pause")),
      terminateSession: () => Effect.sync(() => calls.push("terminate")),
    };
    const result = await Effect.runPromise(
      Effect.either(
        startFileSyncSessions(acceleratedPlan, events, { scope }).pipe(
          Effect.provideService(FileSyncEngine, engine),
        ),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBe(failure);
    expect(calls).toEqual(["resume", "flush", "pause"]);
  });

  test("uses distinct progress IDs for the same mount key in two services", async () => {
    const secondService = ServiceName.make("database");
    const otherEntry = {
      ...entry,
      session: {
        ...entry.session,
        service: secondService,
        target: {
          _tag: "volume" as const,
          name: "test-start-database-app-mount",
          path: PortablePath.make("/app"),
        },
      },
    };
    const twoServicePlan: AppPlan = { ...acceleratedPlan, fileSync: [entry, otherEntry] };
    const published: Array<Parameters<ProgressEmitter["publish"]>[0]> = [];
    const collectingEvents = {
      publish: (event: Parameters<ProgressEmitter["publish"]>[0]) =>
        Effect.sync(() => {
          published.push(event);
        }),
    };
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([]),
      createSession: (spec: typeof entry.session) =>
        Effect.succeed(FileSyncSessionRef.make(`${spec.service}-${spec.mountKey}`)),
    };
    await Effect.runPromise(
      startFileSyncSessions(twoServicePlan, collectingEvents).pipe(
        Effect.provideService(FileSyncEngine, engine),
      ),
    );
    const tree = published.find((event) => event._tag === "task.tree.start");
    const started = published.filter((event) => event._tag === "task.start").map((event) => event.taskId);
    const completed = published
      .filter((event) => event._tag === "task.complete")
      .map((event) => event.taskId);
    expect(tree?._tag).toBe("task.tree.start");
    if (tree?._tag === "task.tree.start") {
      expect(tree.children).toEqual([
        "start-file-sync-test-start:web/app-mount",
        "start-file-sync-test-start:database/app-mount",
      ]);
    }
    expect(started).toEqual([
      "start-file-sync-test-start:web/app-mount",
      "start-file-sync-test-start:database/app-mount",
    ]);
    expect(completed).toEqual(started);
  });
});

describe("prior accelerated mount guard", () => {
  test("blocks unavailable adapter fallback when the provider previously accelerated the app", async () => {
    let applied = false;
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      appliedFileSyncState: "accelerated",
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(false) },
      onApply: () => {
        applied = true;
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow("saved accelerated app requires");
    expect(applied).toBe(false);
  });

  test("blocks an ordinary current plan when prior accelerated state remains", async () => {
    let applied = false;
    const harness = makeHarness({
      plannedApp: plan,
      appliedFileSyncState: "accelerated",
      onApply: () => {
        applied = true;
      },
    });
    await expect(runStart(harness, plan)).rejects.toThrow("saved accelerated app requires");
    expect(applied).toBe(false);
  });

  test("rejects a preparing provider that cannot inspect prior accelerated state", async () => {
    let applied = false;
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      providerCanInspectFileSync: false,
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(true) },
      onApply: () => {
        applied = true;
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow(
      "cannot verify previous accelerated mount state",
    );
    expect(applied).toBe(false);
  });

  test("blocks provider fallback from available sync when prior mounts were accelerated", async () => {
    let applied = false;
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      providerCanPrepareFileSync: false,
      appliedFileSyncState: "accelerated",
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(true) },
      onApply: () => {
        applied = true;
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow("previously used accelerated mounts");
    expect(applied).toBe(false);
  });
  test("blocks uncertain prior state but permits a proven fresh app fallback", async () => {
    const unknown = makeHarness({
      plannedApp: acceleratedPlan,
      appliedFileSyncState: "unknown",
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(false) },
    });
    await expect(runStart(unknown, acceleratedPlan)).rejects.toThrow("could not be verified");
    const applied: AppPlan[] = [];
    const fresh = makeHarness({
      plannedApp: acceleratedPlan,
      appliedFileSyncState: "missing",
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(false) },
      onApply: (next) => applied.push(next),
    });
    await runStart(fresh, acceleratedPlan);
    expect(applied[0]?.fileSync).toEqual([]);
  });
});
describe("pre-apply accelerated mount preparation", () => {
  test("uses ordinary mounts when the selected provider has no target preparation hook", async () => {
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      providerCanPrepareFileSync: false,
      onApply: (next) => applied.push(next),
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(true) },
    });
    await runStart(harness, acceleratedPlan);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.fileSync).toEqual([]);
    expect(applied[0]?.services[web.name]?.appMount?.realization).toBe("passthrough");
    expect(applied[0]?.services[web.name]?.mounts[0]?.realization).toBe("passthrough");
    await Effect.runPromise(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
  });
  test("ordinary mounts start without a target preparation hook or pending journal", async () => {
    const harness = makeHarness({ plannedApp: plan, providerCanPrepareFileSync: false });
    await runStart(harness, plan);
    await Effect.runPromise(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
  });
  test("rejects missing, extra, duplicate, or altered prepared targets before creating sessions", async () => {
    const planned = acceleratedPlan.fileSync;
    const good = planned.map(({ session }, index) => ({
      session,
      endpoint: {
        _tag: "container" as const,
        containerId: ["helper", index].join("-"),
        path: AbsoluteContainerPath.make("/sync"),
        volumeName: session.target._tag === "volume" ? session.target.name : "",
      },
    }));
    const first = good[0];
    const second = good[1];
    if (first === undefined || second === undefined) throw new Error("Expected two prepared targets.");
    const cases = [
      { name: "missing", targets: [first] },
      {
        name: "extra",
        targets: [...good, { ...first, endpoint: { ...first.endpoint, containerId: "extra" } }],
      },
      { name: "duplicate session", targets: [first, { ...first, endpoint: second.endpoint }] },
      { name: "duplicate endpoint", targets: [first, { ...second, endpoint: first.endpoint }] },
      {
        name: "changed source",
        targets: [first, { ...second, session: { ...second.session, source: AbsolutePath.make("/other") } }],
      },
      {
        name: "changed volume",
        targets: [first, { ...second, endpoint: { ...second.endpoint, volumeName: "other-volume" } }],
      },
    ] as const;
    for (const item of cases) {
      const actions: string[] = [];
      const harness = makeHarness({
        plannedApp: acceleratedPlan,
        preparedFileSyncTargets: () => item.targets,
        onFileSyncRollback: () => actions.push("rollback"),
        onApply: () => actions.push("apply"),
        fileSync: {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
          listSessions: () => Effect.succeed([]),
          createSession: () =>
            Effect.sync(() => {
              actions.push("create");
              return FileSyncSessionRef.make("unexpected");
            }),
        },
      });
      await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
      expect(actions).toEqual(["rollback"]);
      await Effect.runPromise(
        requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
          Effect.provide(harness.stateStore.layer),
        ),
      );
    }
  });

  test("binds only the validated app target set before creating sessions", async () => {
    const actions: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => actions.push("prepare"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        createSession: () => Effect.die(new Error("The shared engine must not create an app session.")),
        bindPreparedTargets: (selectedPlan, targets) =>
          Effect.sync(() => {
            expect(actions).toEqual(["prepare"]);
            actions.push("bind");
            expect(selectedPlan.fileSync.map((entry) => entry.session)).toEqual(
              targets.map((target) => target.session),
            );
            return {
              ...TestFileSyncEngine,
              id: "mutagen",
              isAvailable: Effect.succeed(true),
              listSessions: () => Effect.succeed([]),
              createSession: (spec) =>
                Effect.sync(() => {
                  expect(targets.some((target) => target.session === spec)).toBe(true);
                  actions.push("create");
                  return FileSyncSessionRef.make(`scoped-${spec.mountKey}`);
                }),
              flushSession: () => Effect.sync(() => actions.push("flush")),
            };
          }),
      },
      onApply: () => actions.push("apply"),
    });
    await runStart(harness, acceleratedPlan);
    expect(actions).toEqual(["prepare", "bind", "create", "flush", "create", "flush", "apply"]);
  });

  test("interruption during binding rolls back targets and clears the pending journal", async () => {
    const actions: string[] = [];
    let bindingStarted = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      bindingStarted = resolve;
    });
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => actions.push("prepare"),
      onFileSyncRollback: () => actions.push("rollback"),
      onApply: () => actions.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        createSession: () => Effect.die(new Error("Interrupted binding reached session creation.")),
        bindPreparedTargets: () =>
          Effect.sync(() => {
            actions.push("bind");
            bindingStarted();
          }).pipe(Effect.zipRight(Effect.never)),
      },
    });
    const fiber = Effect.runFork(
      startApp(
        {},
        {
          plan: acceleratedPlan,
          root: acceleratedPlan.root,
          app: { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    await entered;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(actions).toEqual(["prepare", "bind", "rollback"]);
    await Effect.runPromise(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
  });

  test("interruption during bound-engine availability rolls back only verified empty targets", async () => {
    for (const ledgerReadable of [true, false]) {
      const actions: string[] = [];
      let checkingAvailability = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        checkingAvailability = resolve;
      });
      const harness = makeHarness({
        plannedApp: acceleratedPlan,
        onPrepareFileSync: () => actions.push("prepare"),
        onFileSyncRollback: () => actions.push("rollback"),
        onApply: () => actions.push("apply"),
        fileSync: {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
          createSession: () => Effect.die(new Error("Shared engine used after binding.")),
          bindPreparedTargets: () =>
            Effect.sync(() => {
              actions.push("bind");
              return {
                ...TestFileSyncEngine,
                id: "mutagen",
                isAvailable: Effect.sync(() => {
                  actions.push("availability");
                  checkingAvailability();
                }).pipe(Effect.zipRight(Effect.never)),
                listSessions: () =>
                  ledgerReadable
                    ? Effect.succeed([])
                    : Effect.fail(
                        new FileSyncStartError({
                          engineId: "mutagen",
                          message: "Durable session ownership could not be read.",
                          remediation: "Inspect the retained ownership ledger before retrying.",
                        }),
                      ),
                createSession: () => Effect.die(new Error("Availability interruption reached creation.")),
              };
            }),
        },
      });
      const fiber = Effect.runFork(
        startApp(
          {},
          {
            plan: acceleratedPlan,
            root: acceleratedPlan.root,
            app: { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root },
          },
        ).pipe(Effect.provide(harness.layer)),
      );
      await entered;
      const exit = await Effect.runPromise(Fiber.interrupt(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(actions).toEqual(
        ledgerReadable
          ? ["prepare", "bind", "availability", "rollback"]
          : ["prepare", "bind", "availability"],
      );
      const journal = await Effect.runPromiseExit(
        requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
          Effect.provide(harness.stateStore.layer),
        ),
      );
      expect(Exit.isSuccess(journal)).toBe(ledgerReadable);
    }
  });

  test("interruption finishes when the ownership inventory stalls", async () => {
    const actions: string[] = [];
    let checkingAvailability = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      checkingAvailability = resolve;
    });
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => actions.push("prepare"),
      onFileSyncRollback: () => actions.push("rollback"),
      onApply: () => actions.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        createSession: () => Effect.die(new Error("Interrupted availability reached creation.")),
        bindPreparedTargets: () =>
          Effect.succeed({
            ...TestFileSyncEngine,
            id: "mutagen",
            isAvailable: Effect.sync(() => {
              actions.push("availability");
              checkingAvailability();
            }).pipe(Effect.zipRight(Effect.never)),
            listSessions: () =>
              Effect.sync(() => actions.push("inventory")).pipe(Effect.zipRight(Effect.never)),
          }),
      },
    });
    const fiber = Effect.runFork(
      startApp(
        {},
        {
          plan: acceleratedPlan,
          root: acceleratedPlan.root,
          app: { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    await entered;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(actions).toEqual(["prepare", "availability", "inventory"]);
    const journal = await Effect.runPromiseExit(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
    expect(Exit.isFailure(journal)).toBe(true);
  }, 10_000);

  test("keeps simultaneous apps on separate bound engines", async () => {
    const otherRootPath = mkdtempSync(join(tmpdir(), "lando-other-start-"));
    const otherRoot = AbsolutePath.make(otherRootPath);
    const otherId = AppId.make("other-app");
    const otherAppMount = acceleratedService.appMount;
    if (otherAppMount === undefined) throw new Error("Accelerated test service needs an app mount.");
    const otherPlan: AppPlan = {
      ...acceleratedPlan,
      id: otherId,
      name: "other-app",
      slug: "other-app",
      root: otherRoot,
      services: {
        [web.name]: {
          ...acceleratedService,
          appMount: { ...otherAppMount, source: otherRoot },
        },
      },
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        session: {
          ...entry.session,
          app: { kind: "user" as const, id: otherId, root: otherRoot },
          source: entry.session.mountKey === "app-mount" ? otherRoot : entry.session.source,
          target:
            entry.session.target._tag === "volume"
              ? {
                  ...entry.session.target,
                  name: fileSyncVolumeName(
                    "other-app",
                    String(entry.session.service),
                    entry.session.mountKey,
                  ),
                }
              : entry.session.target,
        },
      })),
    };
    const boundApps: string[] = [];
    const createdApps: string[] = [];
    const sharedEngine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      isAvailable: Effect.succeed(true),
      createSession: () => Effect.die(new Error("Shared engine used for creation.")),
      bindPreparedTargets: (
        boundPlan: AppPlan,
        targets: ReadonlyArray<import("@lando/sdk/schema").PreparedFileSyncTarget>,
      ) =>
        Effect.sync(() => {
          boundApps.push(String(boundPlan.id));
          return {
            ...TestFileSyncEngine,
            id: "mutagen",
            isAvailable: Effect.succeed(true),
            listSessions: () => Effect.succeed([]),
            createSession: (spec: import("@lando/sdk/schema").FileSyncSessionSpec) =>
              Effect.sync(() => {
                expect(spec.app.id).toBe(boundPlan.id);
                expect(targets.some((target) => target.session === spec)).toBe(true);
                createdApps.push(String(spec.app.id));
                return FileSyncSessionRef.make(`${boundPlan.id}-${spec.mountKey}`);
              }),
          };
        }),
    };
    try {
      await Promise.all([
        runStart(makeHarness({ plannedApp: acceleratedPlan, fileSync: sharedEngine }), acceleratedPlan),
        runStart(makeHarness({ plannedApp: otherPlan, fileSync: sharedEngine }), otherPlan),
      ]);
      expect(boundApps.sort()).toEqual([String(acceleratedPlan.id), String(otherId)].sort());
      expect(createdApps.filter((id) => id === String(acceleratedPlan.id))).toHaveLength(2);
      expect(createdApps.filter((id) => id === String(otherId))).toHaveLength(2);
    } finally {
      rmSync(otherRootPath, { recursive: true, force: true });
    }
  });

  test("rolls back prepared targets if app binding fails before session creation", async () => {
    const actions: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => actions.push("prepare"),
      onFileSyncRollback: () => actions.push("rollback"),
      onApply: () => actions.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        createSession: () => Effect.die(new Error("Binding failure reached the shared engine.")),
        bindPreparedTargets: () =>
          Effect.sync(() => actions.push("bind")).pipe(
            Effect.zipRight(
              Effect.fail(
                new FileSyncStartError({
                  engineId: "mutagen",
                  message: "Could not bind verified endpoints.",
                  remediation: "Retry after checking the provider endpoints.",
                }),
              ),
            ),
          ),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(actions).toEqual(["prepare", "bind", "rollback"]);
    await Effect.runPromise(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
  });

  test("retains the accelerated-start journal if rejected-target rollback fails", async () => {
    const actions: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      preparedFileSyncTargets: () => [],
      onFileSyncRollback: () => actions.push("rollback"),
      fileSyncRollbackEffect: Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "prepareFileSyncTargets.rollback",
          message: "Owned helper removal failed.",
          remediation: "Inspect retained targets before retrying.",
        }),
      ),
      fileSync: { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(true) },
      onApply: () => actions.push("apply"),
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(actions).toEqual(["rollback"]);
    const pending = await Effect.runPromiseExit(
      requireNoPendingAcceleratedStart({ kind: "user", id: plan.id, root: plan.root }).pipe(
        Effect.provide(harness.stateStore.layer),
      ),
    );
    expect(Exit.isFailure(pending)).toBe(true);
  });

  test("does not invalidate a drain for an ordinary first start", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => order.push("prepare"),
      onApply: () => order.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        appLifecycle: {
          invalidateDrain: () =>
            Effect.sync(() => {
              order.push("invalidate");
            }),
          drain: () => Effect.void,
          dispose: () => Effect.void,
          completeDisposal: () => Effect.void,
        },
      },
    });
    await runStart(harness, acceleratedPlan);
    expect(order).toEqual(["prepare", "apply"]);
  });

  test("invalidates a saved durable drain before init hooks run", async () => {
    const order: string[] = [];
    const sessions: ReadonlyArray<FileSyncSessionInfo> = acceleratedPlan.fileSync.map((entry) => ({
      ref: FileSyncSessionRef.make(`sync-${entry.session.mountKey}`),
      app: entry.session.app,
      service: entry.session.service,
      mountKey: entry.session.mountKey,
      spec: entry.session,
      status: "paused",
      lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
    }));
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      appliedFileSyncState: "accelerated",
      onPublish: (event) =>
        event._tag === "pre-init"
          ? Effect.sync(() => {
              order.push("init");
            }).pipe(
              Effect.zipRight(Effect.fail(new EventError({ message: "stop after init", event: "pre-init" }))),
            )
          : Effect.void,
      onPrepareFileSync: () => order.push("prepare"),
      onApply: () => order.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed(sessions),
        appLifecycle: {
          invalidateDrain: () =>
            Effect.sync(() => {
              order.push("invalidate");
            }),
          drain: () => Effect.void,
          dispose: () => Effect.void,
          completeDisposal: () => Effect.void,
        },
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow("stop after init");
    expect(order).toEqual(["invalidate", "init"]);
  });

  test("flushes every session before app containers start and builds after apply", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => order.push("prepare"),
      onApply: () => order.push("apply"),
      onBuildApp: () => order.push("buildApp"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) =>
          Effect.sync(() => {
            order.push(`create:${spec.mountKey}`);
            return FileSyncSessionRef.make(`sync-${spec.mountKey}`);
          }),
        flushSession: (ref) =>
          Effect.sync(() => {
            order.push(`flush:${ref}`);
          }),
      },
    });
    await runStart(harness, acceleratedPlan);
    expect(order).toEqual([
      "prepare",
      "create:app-mount",
      "flush:sync-app-mount",
      "create:mount-0",
      "flush:sync-mount-0",
      "apply",
      "buildApp",
    ]);
  });

  test("apply failure after flush leaves prepared targets untouched", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => order.push("prepare"),
      onFileSyncRollback: () => order.push("rollback"),
      onApply: () => order.push("apply"),
      applyEffect: Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "apply",
          message: "app container failed to start",
        }),
      ),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        flushSession: (ref) =>
          Effect.sync(() => {
            order.push(`flush:${ref}`);
          }),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual(["prepare", "flush:sync-app-mount", "flush:sync-mount-0", "apply"]);
  });
  test("provider apply failure stops writers before reversing new persistent sessions and targets", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => order.push("prepare"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      onApply: () => order.push("apply"),
      onDestroy: () => order.push("destroy"),
      applyEffect: Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "apply", message: "failed" }),
      ),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) =>
          Effect.sync(() => {
            order.push(`create:${spec.mountKey}`);
            return FileSyncSessionRef.make(`sync-${spec.mountKey}`);
          }),
        flushSession: (ref) => Effect.sync(() => order.push(`flush:${ref}`)),
        terminateSession: (ref) => Effect.sync(() => order.push(`terminate:${ref}`)),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual([
      "prepare",
      "create:app-mount",
      "flush:sync-app-mount",
      "create:mount-0",
      "flush:sync-mount-0",
      "apply",
      "destroy",
      "terminate:sync-mount-0",
      "terminate:sync-app-mount",
      "rollback-targets",
    ]);
  });

  test("a post-apply start event failure reverses persistent sessions after writer teardown", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      onPublish: (event) =>
        event._tag === "post-app-start"
          ? Effect.fail(new EventError({ message: "post-app-start failed", event: "post-app-start" }))
          : Effect.void,
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        terminateSession: (ref) => Effect.sync(() => order.push(`terminate:${ref}`)),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow("post-app-start failed");
    expect(order).toEqual([
      "destroy",
      "terminate:sync-mount-0",
      "terminate:sync-app-mount",
      "rollback-targets",
    ]);
  });

  test("a later post-start publish failure removes routes before persistent session rollback", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onRemoveRoutes: () => order.push("remove-routes"),
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      onPublish: (event) =>
        event._tag === "post-start"
          ? Effect.fail(new EventError({ message: "post-start failed", event: "post-start" }))
          : Effect.void,
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        terminateSession: (ref) => Effect.sync(() => order.push(`terminate:${ref}`)),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow("post-start failed");
    expect(order).toEqual([
      "remove-routes",
      "destroy",
      "terminate:sync-mount-0",
      "terminate:sync-app-mount",
      "rollback-targets",
    ]);
  });

  test("interruption after routes preserves writer-stop-before-session cleanup order", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onRemoveRoutes: () => order.push("remove-routes"),
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      onPublish: (event) => (event._tag === "post-start" ? Effect.interrupt : Effect.void),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        terminateSession: (ref) => Effect.sync(() => order.push(`terminate:${ref}`)),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    const routeIndex = order.indexOf("remove-routes");
    const destroyIndex = order.indexOf("destroy");
    const terminateIndex = order.indexOf("terminate:sync-mount-0");
    const rollbackIndex = order.indexOf("rollback-targets");
    expect(routeIndex).toBeGreaterThanOrEqual(0);
    expect(destroyIndex).toBeGreaterThan(routeIndex);
    expect(terminateIndex).toBeGreaterThan(destroyIndex);
    expect(rollbackIndex).toBeGreaterThan(terminateIndex);
    expect(order.filter((step) => step === "remove-routes")).toHaveLength(1);
    expect(order.filter((step) => step === "destroy")).toHaveLength(1);
    expect(order.filter((step) => step.startsWith("terminate:"))).toHaveLength(2);
    expect(order.filter((step) => step === "rollback-targets")).toHaveLength(1);
  });

  test("fiber interruption after partial route publication removes routes before session rollback", async () => {
    const order: string[] = [];
    let routeEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      routeEntered = resolve;
    });
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      afterApplyRoutes: Effect.sync(() => {
        order.push("route-applied");
        routeEntered();
      }).pipe(Effect.zipRight(Effect.never)),
      onRemoveRoutes: () => order.push("remove-routes"),
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        terminateSession: (ref) => Effect.sync(() => order.push(`terminate:${ref}`)),
      },
    });
    const fiber = Effect.runFork(
      startApp(
        {},
        {
          plan: acceleratedPlan,
          root: acceleratedPlan.root,
          app: { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    await entered;
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(order).toEqual([
      "route-applied",
      "remove-routes",
      "destroy",
      "terminate:sync-mount-0",
      "terminate:sync-app-mount",
      "rollback-targets",
    ]);
  });

  test("provider teardown failure preserves persistent sessions and prepared targets", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      destroyEffect: Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "destroy",
          message: "writers remain",
        }),
      ),
      applyEffect: Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "apply", message: "failed" }),
      ),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        terminateSession: () => Effect.sync(() => order.push("terminate")),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual(["destroy", "destroy"]);
  });

  test("provider apply failure re-pauses prior persistent sessions without removing their target", async () => {
    const order: string[] = [];
    const existing: ReadonlyArray<FileSyncSessionInfo> = acceleratedPlan.fileSync.map((entry) => ({
      ref: FileSyncSessionRef.make(`prior-${entry.session.mountKey}`),
      app: entry.session.app,
      service: entry.session.service,
      mountKey: entry.session.mountKey,
      spec: entry.session,
      status: "paused",
      lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
    }));
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      appliedFileSyncState: "accelerated",
      onDestroy: () => order.push("destroy"),
      onFileSyncRollback: () => order.push("rollback-targets"),
      applyEffect: Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "apply", message: "failed" }),
      ),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: ({ mountKey }) =>
          Effect.succeed(
            mountKey === undefined ? existing : existing.filter((item) => item.mountKey === mountKey),
          ),
        resumeSession: (ref) => Effect.sync(() => order.push(`resume:${ref}`)),
        pauseSession: (ref) => Effect.sync(() => order.push(`pause:${ref}`)),
        terminateSession: () => Effect.sync(() => order.push("terminate")),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual([
      "resume:prior-app-mount",
      "resume:prior-mount-0",
      "destroy",
      "pause:prior-mount-0",
      "pause:prior-app-mount",
    ]);
  });

  test("failed initial flush rolls back preparation before any provider apply", async () => {
    const order: string[] = [];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onPrepareFileSync: () => order.push("prepare"),
      onFileSyncRollback: () => order.push("rollback"),
      onApply: () => order.push("apply"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        flushSession: () =>
          Effect.sync(() => order.push("flush")).pipe(
            Effect.zipRight(
              Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "initial sync failed" })),
            ),
          ),
        terminateSession: () => Effect.sync(() => order.push("terminate")),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual(["prepare", "flush", "terminate", "rollback"]);
  });

  test("a later unvisited existing session prevents target rollback after an earlier flush fails", async () => {
    const order: string[] = [];
    const later = acceleratedPlan.fileSync[1];
    if (later === undefined) throw new Error("Missing later mount");
    const existing: FileSyncSessionInfo = {
      ref: FileSyncSessionRef.make("prior-mount-0"),
      app: later.session.app,
      service: later.session.service,
      mountKey: later.session.mountKey,
      spec: later.session,
      status: "running",
      lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
    };
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onFileSyncRollback: () => order.push("rollback"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: ({ mountKey }) => Effect.succeed(mountKey === "app-mount" ? [] : [existing]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        flushSession: () =>
          Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "flush failed" })),
        terminateSession: () => Effect.sync(() => order.push("terminate")),
      },
    });
    await expect(runStart(harness, acceleratedPlan)).rejects.toThrow();
    expect(order).toEqual(["terminate"]);
  });

  test("failed session termination preserves targets and both failures", async () => {
    const order: string[] = [];
    const flushFailure = new FileSyncStartError({ engineId: "mutagen", message: "flush failed" });
    const terminateFailure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: "sync-app-mount",
      message: "terminate failed",
    });
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onFileSyncRollback: () => order.push("rollback"),
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
        createSession: (spec) => Effect.succeed(FileSyncSessionRef.make(`sync-${spec.mountKey}`)),
        flushSession: () => Effect.fail(flushFailure),
        terminateSession: () =>
          Effect.sync(() => order.push("terminate")).pipe(Effect.zipRight(Effect.fail(terminateFailure))),
      },
    });
    const exit = await Effect.runPromiseExit(
      startApp(
        {},
        {
          plan: acceleratedPlan,
          root: acceleratedPlan.root,
          app: { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root },
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Array.from(Cause.failures(exit.cause))).toEqual([flushFailure, terminateFailure]);
    }
    expect(order).toEqual(["terminate"]);
  });
});
