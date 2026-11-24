import { describe, expect, test } from "bun:test";
import { FileSyncStopError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppRef,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { hasStopFileSyncCoverage, terminateFileSyncSessions } from "../../src/operations/file-sync.ts";
import { provideFileSyncEngine } from "../file-sync-engine.ts";

const app: AppRef = {
  kind: "user",
  id: AppId.make("sync-teardown"),
  root: AbsolutePath.make("/tmp/sync-teardown"),
};
const ref = FileSyncSessionRef.make("sync-teardown-web-app-mount");
const spec = {
  app,
  service: ServiceName.make("web"),
  mountKey: "app-mount",
  source: app.root,
  target: { _tag: "volume" as const, name: "sync-teardown-web-app-mount", path: PortablePath.make("/app") },
  mode: "two-way-safe" as const,
  excludes: [],
};
const session: FileSyncSessionInfo = {
  ref,
  app,
  service: spec.service,
  mountKey: spec.mountKey,
  spec,
  status: "running",
  lastUpdatedAt: DateTime.makeUnsafe("2026-09-23T00:00:00Z"),
};

describe("file-sync teardown", () => {
  test("stop coverage skips paused or missing sessions of services without containers", () => {
    const paused = { ...session, status: "paused" as const };
    expect(hasStopFileSyncCoverage([spec], [paused], new Set(["web"]))).toBe(true);
    expect(hasStopFileSyncCoverage([spec], [], new Set(["web"]))).toBe(true);
    expect(hasStopFileSyncCoverage([spec], [], new Set())).toBe(false);
    expect(hasStopFileSyncCoverage([spec], [session], new Set())).toBe(true);
  });

  test("terminate skips a paused session whose service container is already gone", async () => {
    const calls: string[] = [];
    const paused = { ...session, status: "paused" as const };
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([paused]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
        }),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }),
    };
    await Effect.runPromise(
      terminateFileSyncSessions(app, [paused], new Set(["web"])).pipe(provideFileSyncEngine(engine)),
    );
    expect(calls).toEqual([]);
  });

  test("a flush failure leaves the session running for recovery", async () => {
    let terminated = false;
    const failure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: String(ref),
      message: "flush failed",
      remediation:
        "Retry the flush; if it keeps failing, leave the session running and inspect Mutagen session status before stop.",
    });
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([session]),
      flushSession: () => Effect.fail(failure),
      terminateSession: () =>
        Effect.sync(() => {
          terminated = true;
        }),
    };
    const error = await Effect.runPromise(
      terminateFileSyncSessions(app).pipe(provideFileSyncEngine(engine), Effect.flip),
    );
    expect(error).toBe(failure);
    expect(terminated).toBe(false);
  });

  test("a changed session snapshot is not flushed or terminated", async () => {
    const calls: string[] = [];
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([{ ...session, ref: FileSyncSessionRef.make("replacement") }]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
        }),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }),
    };
    const error = await Effect.runPromise(
      terminateFileSyncSessions(app, [session]).pipe(provideFileSyncEngine(engine), Effect.flip),
    );
    expect(error._tag).toBe("FileSyncStopError");
    expect(calls).toEqual([]);
  });
  test("an unhealthy session is not flushed or terminated", async () => {
    const calls: string[] = [];
    const engine = {
      ...TestFileSyncEngine,
      id: "mutagen",
      listSessions: () => Effect.succeed([{ ...session, status: "errored" as const }]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
        }),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }),
    };
    const error = await Effect.runPromise(
      terminateFileSyncSessions(app).pipe(provideFileSyncEngine(engine), Effect.flip),
    );
    expect(error._tag).toBe("FileSyncStopError");
    expect(calls).toEqual([]);
  });
});
