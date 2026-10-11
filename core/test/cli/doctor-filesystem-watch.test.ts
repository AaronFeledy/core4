import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, PathsService } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { filesystemWatchDoctor } from "../../src/cli/commands/doctor-filesystem-watch";
import { FilesystemWatchIO, type WatchNativeIO } from "../../src/cli/commands/doctor-filesystem-watch-io";
import { collectDoctorReport } from "../../src/cli/commands/doctor-report";

const io: WatchNativeIO = {
  readLimit: async () => "1",
  makeDirectory: async () => "/private/test",
  watchDirectory: () => ({ close: () => {} }),
  removeDirectory: async () => {},
};
const systemError = (code: string) => Object.assign(new Error("secret /private/test"), { code });
const run = (native: WatchNativeIO = io, platform = "linux") =>
  Effect.runPromise(
    filesystemWatchDoctor((text) => text, platform).pipe(Effect.provide(FilesystemWatchIO.layerWith(native))),
  );

test("passes one allocation even when all configured limits are tiny", async () => {
  // Given / When
  const [check] = await run();
  // Then
  expect(check).toMatchObject({
    status: "pass",
    solutions: [],
    context: {
      max_user_watches: "1",
      max_user_instances: "1",
      max_queued_events: "1",
      allocation: "allocated",
      usage: "unknown",
      pressure: "unknown",
      providerVm: "unobserved",
      eventDelivery: "unobserved",
      spareCapacity: "unknown",
      cleanup: "complete",
    },
  });
});

test.each(["explicit", "paths"])("probes WSL from %s rather than the ambient platform", async (source) => {
  // Given
  expect(process.platform).not.toBe("wsl");
  const paths = makeLandoPaths({ platform: source === "explicit" ? "darwin" : "wsl", env: {} });
  // When
  const [check] = await Effect.runPromise(
    filesystemWatchDoctor((text) => text, source === "explicit" ? "wsl" : undefined).pipe(
      Effect.provideService(PathsService, paths),
      Effect.provide(FilesystemWatchIO.layerWith(io)),
    ),
  );
  // Then
  expect(check).toMatchObject({ status: "pass", context: { platform: "wsl", allocation: "allocated" } });
});

test.each([
  ["ENOSPC", "inotify-watch-budget-or-kernel-allocation"],
  ["EMFILE", "process-fd-or-user-inotify-instance-limit"],
  ["ENFILE", "system-fd-limit"],
  ["EACCES", "permission-denied"],
  ["ENOSYS", "unsupported"],
  ["EIO", "unknown"],
])("classifies watch allocation %s without claiming uniquely known pressure", async (code, reason) => {
  // Given
  const native = {
    ...io,
    watchDirectory: () => {
      throw systemError(code);
    },
  };
  // When
  const [check] = await run(native);
  // Then
  expect(check).toMatchObject({
    status: "fail",
    recovery: "manual",
    context: { stage: "watch", errno: code, allocation: reason },
  });
  expect(JSON.stringify(check)).not.toContain("/private/test");
  expect(check?.solutions.every(({ kind }) => kind === "manual")).toBe(true);
});

test("classifies temp-directory ENOSPC as storage rather than inotify", async () => {
  // Given
  const native = {
    ...io,
    makeDirectory: async () => {
      throw systemError("ENOSPC");
    },
  };
  // When
  const [check] = await run(native);
  // Then
  expect(check).toMatchObject({
    status: "fail",
    context: { stage: "setup", allocation: "temporary-storage-full" },
  });
});

test.each(["EACCES", "EPERM", "ENOENT"])(
  "keeps denied or absent limit visibility honest for %s",
  async (code) => {
    // Given
    const native = {
      ...io,
      readLimit: async () => {
        throw systemError(code);
      },
    };
    // When
    const [check] = await run(native);
    // Then
    expect(check?.status).toBe("pass");
    expect(check?.context.max_user_watches).toBe(
      `${code === "ENOENT" ? "unavailable" : "restricted"}:${code}`,
    );
  },
);

test.each(["darwin", "win32", "freebsd"])("avoids native IO on unsupported %s", async (platform) => {
  // Given
  let calls = 0;
  const native = {
    ...io,
    readLimit: async () => {
      calls++;
      return "1";
    },
  };
  // When
  const [check] = await run(native, platform);
  // Then
  expect(check).toMatchObject({ status: "warn", context: { platform, observation: "unsupported-platform" } });
  expect(calls).toBe(0);
});

test("redacts every context value and remediation before returning it", async () => {
  // Given
  const redact = (_text: string) => "[redacted]";
  // When
  const [check] = await Effect.runPromise(
    filesystemWatchDoctor(redact, "linux").pipe(
      Effect.provide(
        FilesystemWatchIO.layerWith({
          ...io,
          watchDirectory: () => {
            throw systemError("EMFILE");
          },
        }),
      ),
    ),
  );
  // Then
  expect(Object.values(check?.context ?? {}).every((value) => value === "[redacted]")).toBe(true);
  expect(check?.solutions[0]?.description).toBe("[redacted]");
});

test("bounds stalled IO to one attempt and interrupts its scope", async () => {
  // Given
  let interrupted = false;
  // When
  const checks = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        filesystemWatchDoctor((text) => text, "linux").pipe(
          Effect.provideService(
            FilesystemWatchIO,
            FilesystemWatchIO.of({
              observe: Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
            }),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(501);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  // Then
  expect(checks[0]).toMatchObject({
    status: "warn",
    context: { allocation: "unknown", cleanup: "pending-or-unobserved" },
  });
  expect(interrupted).toBe(true);
});

test.each([false, true])(
  "combined report retains manual host check without provider bootstrap, fix=%s",
  async (fix) => {
    // Given
    const config = Schema.decodeUnknownSync(GlobalConfig)({});
    let allocations = 0;
    const native = {
      ...io,
      watchDirectory: () => {
        allocations++;
        throw systemError("ENOSPC");
      },
    };
    // When
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: { fix, env: {}, platform: "linux" },
        provider: Effect.succeed({ checks: [] }),
        deprecations: Effect.succeed({ entries: [] }),
        subsystems: () => Effect.succeed({ checks: [] }),
      }).pipe(
        Effect.provideService(
          ConfigService,
          ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
        ),
        Effect.provide(FilesystemWatchIO.layerWith(native)),
      ),
    );
    // Then
    expect(report.provider.checks).toEqual([]);
    expect(report.subsystems.checks.filter(({ name }) => name === "filesystem-watch")).toMatchObject([
      { status: "fail", recovery: "manual", solutions: [{ kind: "manual" }, { kind: "manual" }] },
    ]);
    expect(allocations).toBe(1);
  },
);

test("collector reports unexpected watch probe defects instead of hiding them as unavailable", async () => {
  // Given
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  // When
  const report = await Effect.runPromise(
    collectDoctorReport({
      options: { env: { LANDO_TEST_SECRET: "private-probe-secret" }, platform: "linux" },
      provider: Effect.succeed({ checks: [] }),
      deprecations: Effect.succeed({ entries: [] }),
      subsystems: () => Effect.succeed({ checks: [] }),
    }).pipe(
      Effect.provideService(
        ConfigService,
        ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
      ),
      Effect.provideService(
        FilesystemWatchIO,
        FilesystemWatchIO.of({ observe: Effect.die(new Error("private-probe-secret")) }),
      ),
    ),
  );
  // Then
  expect(report.self?.checks).toContainEqual(
    expect.objectContaining({ section: "filesystem-watch", status: "fail" }),
  );
  expect(report.subsystems.checks.some(({ name }) => name === "filesystem-watch")).toBe(false);
  expect(JSON.stringify(report)).not.toContain("private-probe-secret");
});
