import { expect, test } from "bun:test";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { acceleratedStartsDoctor } from "../../src/cli/commands/doctor-accelerated-starts";

test("minimal doctor does not inspect ambient state without a supplied StateStore", async () => {
  // Given a filesystem service but no runtime state store.
  let scans = 0;
  // When the optional accelerated-start check runs.
  const checks = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* acceleratedStartsDoctor((value) => value).pipe(
        Effect.provideService(
          FileSystem,
          FileSystem.of({
            ...fs,
            readDir: () =>
              Effect.sync(() => {
                scans++;
                return [];
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  // Then it leaves the host alone and adds no checks to the minimal report.
  expect(checks).toEqual([]);
  expect(scans).toBe(0);
});

test.each(["retained", "preparing", "sessions-ready", "apply-intent"] as const)(
  "doctor reports pending %s attempts with ownership context and manual remediation",
  async (phase) => {
    // Given a retained version-1 journal in the state-store namespace.
    const store = makeTestStateStore();
    const key = `${"a".repeat(64)}.json`;
    const bucket = await Effect.runPromise(
      store.service.open({
        root: "userData",
        namespace: "accelerated-starts",
        key,
        schema: Schema.Unknown,
        version: 1,
      }),
    );
    await Effect.runPromise(
      bucket.set({
        attemptId: "attempt-1",
        appId: "demo",
        appRoot: "/apps/demo",
        providerId: "lando",
        engineId: "mutagen",
        mountPlanDigest: "digest",
        phase,
        ...(phase === "retained" ? {} : { recoveredFrom: "original-attempt" }),
        sessions: [{ name: "web/app-mount", specDigest: "spec" }],
        targets: [
          { service: "web", mountKey: "app-mount", volumeName: "demo-sync", helperSpecDigest: "helper" },
        ],
      }),
    );
    // When doctor scans the namespace through the filesystem service.
    const checks = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        return yield* acceleratedStartsDoctor((value) => value).pipe(
          Effect.provideService(FileSystem, FileSystem.of({ ...fs, readDir: () => Effect.succeed([key]) })),
          Effect.provide(store.layer),
        );
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );
    // Then it reports the durable identities and both user recovery commands without auto-fixing.
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "accelerated-start",
      status: "fail",
      recovery: "manual",
      context: {
        appId: "demo",
        appRoot: "/apps/demo",
        phase,
        attemptId: "attempt-1",
        journalPath: bucket.path,
        sessions: "web/app-mount",
        volumes: "demo-sync",
      },
    });
    expect(checks[0]?.solutions[0]?.description).toContain("lando start");
    expect(checks[0]?.solutions[0]?.description).toContain("lando destroy");
    if (phase !== "retained")
      expect(checks[0]?.context).toMatchObject({
        recoveredFrom: "original-attempt",
        recoveryState: "interrupted recovery",
      });
  },
);
