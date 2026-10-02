import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit } from "effect";

import { type FileSyncSessionInfo, FileSyncSessionRef, PortablePath, ServiceName } from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { stopAppForTarget } from "../../src/operations/stop.ts";
import { makeHarness, plan } from "./destroy-progress-topology-support.ts";

const app = { kind: "user" as const, id: plan.id, root: plan.root };
const session: FileSyncSessionInfo = {
  ref: FileSyncSessionRef.make("stop-web-app-mount"),
  app,
  service: ServiceName.make("web"),
  mountKey: "app-mount",
  spec: {
    app,
    service: ServiceName.make("web"),
    mountKey: "app-mount",
    source: plan.root,
    target: { _tag: "volume", name: "stop-web-app-mount", path: PortablePath.make("/app") },
    mode: "two-way-safe",
    excludes: [],
  },
  status: "running",
  lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
};
const target = { plan, root: plan.root, app };

const runStop = (harness: ReturnType<typeof makeHarness>) =>
  Effect.runPromiseExit(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));

describe("stop file sync safety", () => {
  test("stops an ordinary app without a file sync engine", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "ordinary",
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["stop-provider"]);
  });

  test("stops a previously ordinary app when the current plan proposes acceleration", async () => {
    const calls: string[] = [];
    const planned = { ...plan, fileSync: [{ engineId: "mutagen", session: session.spec }] };
    const harness = makeHarness({
      appliedFileSyncState: "ordinary",
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await Effect.runPromiseExit(
      stopAppForTarget({}, { ...target, plan: planned }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["stop-provider"]);
  });

  test("stops the saved accelerated mount after the Landofile mount changes", async () => {
    const calls: string[] = [];
    const changed = {
      ...plan,
      fileSync: [{ engineId: "mutagen", session: { ...session.spec, mountKey: "renamed" } }],
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("terminate");
          }),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("provider");
      }),
    });
    const exit = await Effect.runPromiseExit(
      stopAppForTarget({}, { ...target, plan: changed }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["provider", "flush", "terminate"]);
  });

  test("rejects a different selected engine than the saved accelerated engine", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncEngineId: "other-engine",
      appliedFileSyncSessions: [session.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("does not stop an accelerated app when its sync engine is unavailable", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec],
      fileSync: { ...TestFileSyncEngine, isAvailable: Effect.succeed(false) },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("does not stop an accelerated app when its session is missing", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec],
      fileSync: {
        ...TestFileSyncEngine,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([]),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("rejects unknown applied state before init hooks run", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "unknown",
      fileSync: {
        ...TestFileSyncEngine,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    expect(harness.events.some((event) => event._tag === "pre-init" || event._tag === "post-init")).toBe(
      false,
    );
  });

  test("a mount removed from the current Landofile blocks stop when its prior session is missing", async () => {
    const calls: string[] = [];
    const previousSecondMount = {
      ...session.spec,
      mountKey: "mount-1",
      target: { ...session.spec.target, name: "stop-web-mount-1" },
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec, previousSecondMount],
      fileSync: {
        ...TestFileSyncEngine,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("an ordinary app ignores stale file sync sessions", async () => {
    const calls: string[] = [];
    let lists = 0;
    const harness = makeHarness({
      appliedFileSyncState: "ordinary",
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.sync(() => (++lists === 1 ? [] : [session])),
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("terminate");
          }),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["stop-provider"]);
    expect(lists).toBe(0);
  });
  test("drains durable sessions after writers stop and permits a repeated stop", async () => {
    const calls: string[] = [];
    const paused = { ...session, status: "paused" as const };
    let state: FileSyncSessionInfo = session;
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        sessionsPersistAcrossProcesses: true,
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([state]),
        appLifecycle: {
          invalidateDrain: () => Effect.void,
          drain: () =>
            Effect.sync(() => {
              calls.push("drain");
              state = paused;
            }),
          dispose: () => Effect.void,
          completeDisposal: () => Effect.void,
        },
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush-session");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("terminate-session");
          }),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    expect(Exit.isSuccess(await runStop(harness))).toBe(true);
    expect(Exit.isSuccess(await runStop(harness))).toBe(true);
    expect(calls).toEqual(["stop-provider", "drain", "stop-provider", "drain"]);
  });

  test("stops app writers before flushing and terminating a verified session", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [session.spec],
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed([session]),
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("terminate");
          }),
      },
      destroyEffect: Effect.sync(() => {
        calls.push("stop-provider");
      }),
    });
    const exit = await runStop(harness);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["stop-provider", "flush", "terminate"]);
  });
});
