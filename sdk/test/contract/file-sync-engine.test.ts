import { describe, expect, test } from "bun:test";

import { Effect, Stream } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import { type AppRef, FileSyncSessionRef } from "@lando/sdk/schema";
import type { FileSyncEngine } from "@lando/sdk/services";
import {
  ContractFailure,
  TestFileSyncEngine,
  runFileSyncEngineContract,
  runFileSyncEngineContractMatrix,
} from "@lando/sdk/test";

const APP_REF: AppRef = {
  kind: "user",
  id: "myapp",
  root: "/srv/apps/myapp",
} as AppRef;

const buildSpec = (mountKey: string) => ({
  app: APP_REF,
  service: "web" as never,
  mountKey,
  source: "/srv/apps/myapp" as never,
  target: { _tag: "volume" as const, name: `lando-sync-${mountKey}`, path: "/app" as never },
  mode: "two-way-safe" as const,
  excludes: ["node_modules"],
});

const freshTestFileSyncEngine = (): typeof TestFileSyncEngine =>
  ({ ...TestFileSyncEngine }) as typeof TestFileSyncEngine;

const expectContractFailure = async (engine: typeof TestFileSyncEngine, assertion: string): Promise<void> => {
  const result = await Effect.runPromiseExit(runFileSyncEngineContract(engine));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("FileSyncEngine contract", () => {
  test("exports a runnable Effect contract helper", async () => {
    const contract = runFileSyncEngineContract(freshTestFileSyncEngine());
    expect(Effect.isEffect(contract)).toBe(true);
    await expect(Effect.runPromise(contract)).resolves.toBeUndefined();
  });

  test("TestFileSyncEngine satisfies the FileSyncEngine service shape", () => {
    const engine: typeof FileSyncEngine.Service = freshTestFileSyncEngine();
    expect(engine.id).toBe("test");
    expect(typeof engine.createSession).toBe("function");
    expect(typeof engine.pauseSession).toBe("function");
    expect(typeof engine.resumeSession).toBe("function");
    expect(typeof engine.terminateSession).toBe("function");
    expect(typeof engine.listSessions).toBe("function");
    expect(typeof engine.streamEvents).toBe("function");
  });

  test("exposes the section 10.6.1 lifecycle methods as Effect or Stream", () => {
    const spec = buildSpec("app-root");
    expect(Effect.isEffect(TestFileSyncEngine.isAvailable)).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.setup({ force: false }))).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.createSession(spec))).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.pauseSession(FileSyncSessionRef.make("x")))).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.resumeSession(FileSyncSessionRef.make("x")))).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.terminateSession(FileSyncSessionRef.make("x")))).toBe(true);
    expect(Effect.isEffect(TestFileSyncEngine.listSessions({}))).toBe(true);
    expect(Stream.StreamTypeId in Object(TestFileSyncEngine.streamEvents(FileSyncSessionRef.make("x")))).toBe(
      true,
    );
  });

  test("TestFileSyncEngine reports correct status round-trip (start -> running, pause -> paused, resume -> running, terminate -> removed)", async () => {
    const engine = freshTestFileSyncEngine();
    const spec = buildSpec("status-trip");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* engine.createSession(spec);
          let listing = yield* engine.listSessions({});
          expect(listing.find((s) => s.ref === ref)?.status).toBe("running");

          yield* engine.pauseSession(ref);
          listing = yield* engine.listSessions({});
          expect(listing.find((s) => s.ref === ref)?.status).toBe("paused");

          yield* engine.resumeSession(ref);
          listing = yield* engine.listSessions({});
          expect(listing.find((s) => s.ref === ref)?.status).toBe("running");

          yield* engine.terminateSession(ref);
          listing = yield* engine.listSessions({});
          expect(listing.find((s) => s.ref === ref)).toBeUndefined();
        }),
      ),
    );
  });

  test("idempotency: terminateSession is safe to call twice and pauseSession is safe to call twice", async () => {
    const engine = freshTestFileSyncEngine();
    const spec = buildSpec("idempotent");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* engine.createSession(spec);

          yield* engine.pauseSession(ref);
          yield* engine.pauseSession(ref);

          yield* engine.terminateSession(ref);
          yield* engine.terminateSession(ref);
        }),
      ),
    );
  });

  test("scope finalization removes an unterminated TestFileSyncEngine session", async () => {
    const engine = freshTestFileSyncEngine();
    const spec = buildSpec("scope-finalizer");

    const ref = await Effect.runPromise(Effect.scoped(engine.createSession(spec)));
    const listing = await Effect.runPromise(engine.listSessions({}));
    expect(listing.find((s) => s.ref === ref)).toBeUndefined();
  });

  test("contract helper rejects engines that do not map outside-root sources to FileSyncStartError", async () => {
    const engine = freshTestFileSyncEngine();
    const createSession = engine.createSession;
    const broken = {
      ...engine,
      createSession(this: typeof TestFileSyncEngine, spec: ReturnType<typeof buildSpec>) {
        return spec.source === "/etc"
          ? Effect.fail(new FileSyncStopError({ engineId: "test", sessionRef: "x", message: "wrong" }))
          : createSession.call(this, spec);
      },
    } as typeof TestFileSyncEngine;

    await expectContractFailure(broken, "outside-root source fails with FileSyncStartError");
  });

  test("contract helper rejects engines that do not map conflict streams to FileSyncDriftError", async () => {
    const engine = freshTestFileSyncEngine();
    const streamEvents = engine.streamEvents;
    const broken = {
      ...engine,
      streamEvents(this: typeof TestFileSyncEngine, ref: FileSyncSessionRef) {
        return ref === "__CONFLICT__"
          ? Stream.fail(new FileSyncStartError({ engineId: "test", message: "wrong" }))
          : streamEvents.call(this, ref);
      },
    } as typeof TestFileSyncEngine;

    await expectContractFailure(broken, "conflict event stream fails with FileSyncDriftError");
  });

  test("contract helper rejects engines that do not map stop failures to FileSyncStopError", async () => {
    const engine = freshTestFileSyncEngine();
    const terminateSession = engine.terminateSession;
    const broken = {
      ...engine,
      terminateSession(this: typeof TestFileSyncEngine, ref: FileSyncSessionRef) {
        return ref === "__STOP_FAIL__"
          ? Effect.fail(new FileSyncStartError({ engineId: "test", message: "wrong" }))
          : terminateSession.call(this, ref);
      },
    } as typeof TestFileSyncEngine;

    await expectContractFailure(broken, "stop failure fails with FileSyncStopError");
  });

  test("error semantics: createSession failure surfaces FileSyncStartError", async () => {
    const engine = freshTestFileSyncEngine();
    const rejected = { ...buildSpec("reject-me"), mountKey: "__REJECT__" as never };

    const exit = await Effect.runPromiseExit(Effect.scoped(engine.createSession(rejected)));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(FileSyncStartError);
    expect(exit.cause.error._tag).toBe("FileSyncStartError");
  });

  test("error semantics: outside-root source surfaces FileSyncStartError", async () => {
    const engine = freshTestFileSyncEngine();
    const rejected = { ...buildSpec("outside-root"), source: "/etc" as never };

    const exit = await Effect.runPromiseExit(Effect.scoped(engine.createSession(rejected)));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(FileSyncStartError);
    expect(exit.cause.error._tag).toBe("FileSyncStartError");
  });

  test("error semantics: streamEvents emits a FileSyncDriftError for the test conflict ref", async () => {
    const engine = freshTestFileSyncEngine();
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(engine.streamEvents(FileSyncSessionRef.make("__CONFLICT__"))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(FileSyncDriftError);
  });

  test("error semantics: terminateSession on the failure sentinel ref surfaces FileSyncStopError", async () => {
    const engine = freshTestFileSyncEngine();
    const exit = await Effect.runPromiseExit(
      engine.terminateSession(FileSyncSessionRef.make("__STOP_FAIL__")),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(FileSyncStopError);
  });

  test("fails with ContractFailure when engine identity is empty", async () => {
    const engine = { ...TestFileSyncEngine, displayName: "" } as typeof TestFileSyncEngine;
    await expectContractFailure(engine, "engine exposes a non-empty displayName");
  });

  test("fails with ContractFailure when capabilities matrix does not decode", async () => {
    const engine = {
      ...TestFileSyncEngine,
      capabilities: {
        ...TestFileSyncEngine.capabilities,
        modes: undefined,
      },
    } as unknown as typeof TestFileSyncEngine;

    await expectContractFailure(engine, "capabilities decode");
  });

  test("fails with ContractFailure when listSessions does not return an array", async () => {
    const engine = {
      ...TestFileSyncEngine,
      listSessions: () => Effect.succeed("not-an-array"),
    } as unknown as typeof TestFileSyncEngine;

    await expectContractFailure(engine, "listSessions returns an array");
  });
});

describe("runFileSyncEngineContractMatrix", () => {
  test("is exported as an Effect-returning matrix runner", () => {
    expect(typeof runFileSyncEngineContractMatrix).toBe("function");
  });

  test("runs supported cells and reports skipped cells with reason", async () => {
    const report = await Effect.runPromise(
      runFileSyncEngineContractMatrix({
        engineName: "test",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(freshTestFileSyncEngine()),
          },
          { platform: "darwin" as const, supported: false, skipReason: "not yet supported" },
          { platform: "win32" as const, supported: false, skipReason: "not yet supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not yet supported" },
        ],
      }),
    );

    expect(report.engineName).toBe("test");
    expect(report.results).toHaveLength(4);
    expect(report.results[0]).toMatchObject({ platform: "linux", outcome: "passed" });
    expect(report.results[1]).toMatchObject({
      platform: "darwin",
      outcome: "skipped",
      reason: "not yet supported",
    });
  });

  test("requires every canonical host platform to be declared", async () => {
    const exit = await Effect.runPromiseExit(
      runFileSyncEngineContractMatrix({
        engineName: "missing-platform",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(freshTestFileSyncEngine()),
          },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("matrix declares every canonical host platform");
  });

  test("requires a skipReason for unsupported cells", async () => {
    const exit = await Effect.runPromiseExit(
      runFileSyncEngineContractMatrix({
        engineName: "missing-skip-reason",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(freshTestFileSyncEngine()),
          },
          { platform: "darwin" as const, supported: false } as unknown as {
            platform: "darwin";
            supported: false;
            skipReason: string;
          },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("unsupported matrix cell declares a skip reason");
  });

  test("fails when a supported cell's contract fails", async () => {
    const broken = { ...TestFileSyncEngine, displayName: "" } as typeof TestFileSyncEngine;

    const exit = await Effect.runPromiseExit(
      runFileSyncEngineContractMatrix({
        engineName: "broken",
        cells: [
          {
            platform: "linux" as const,
            supported: true,
            factory: () => Effect.succeed(broken),
          },
          { platform: "darwin" as const, supported: false, skipReason: "not supported" },
          { platform: "win32" as const, supported: false, skipReason: "not supported" },
          { platform: "wsl" as const, supported: false, skipReason: "not supported" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe("engine exposes a non-empty displayName");
  });
});
