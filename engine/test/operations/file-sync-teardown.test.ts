import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

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
import { FileSyncEngine } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";

import { terminateFileSyncSessions } from "../../src/operations/file-sync.ts";

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
  lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
};

describe("file-sync teardown", () => {
  test("a flush failure leaves the session running for recovery", async () => {
    let terminated = false;
    const failure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: String(ref),
      message: "flush failed",
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
      terminateFileSyncSessions(app).pipe(Effect.provideService(FileSyncEngine, engine), Effect.flip),
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
      terminateFileSyncSessions(app, [session]).pipe(
        Effect.provideService(FileSyncEngine, engine),
        Effect.flip,
      ),
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
      terminateFileSyncSessions(app).pipe(Effect.provideService(FileSyncEngine, engine), Effect.flip),
    );
    expect(error._tag).toBe("FileSyncStopError");
    expect(calls).toEqual([]);
  });
});
