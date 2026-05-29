import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Stream } from "effect";

import { FileSyncDriftError, FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  ServiceName,
} from "@lando/sdk/schema";

import {
  ENGINE_DISPLAY_NAME,
  ENGINE_ID,
  type FakeMutagenClient,
  MUTAGEN_FAKE_SENTINELS,
  makeFakeMutagenClient,
  makeFileSyncEngine,
  makeUnavailableMutagenClient,
  mutagenCapabilities,
  mutagenSessionName,
} from "../src/index.ts";

const APP_ROOT = AbsolutePath.make("/srv/apps/myapp");

const buildSpec = (
  overrides: Partial<{ mountKey: string; service: string; source: AbsolutePath }> = {},
): FileSyncSessionSpec => ({
  app: { kind: "user", id: AppId.make("myapp"), root: APP_ROOT },
  service: ServiceName.make(overrides.service ?? "web"),
  mountKey: overrides.mountKey ?? "src",
  source: overrides.source ?? APP_ROOT,
  target: { _tag: "volume", name: "lando-sync-src", path: "/app" as never },
  mode: "two-way-safe",
  excludes: ["node_modules"],
});

const fakeEngine = (
  initialState: Parameters<typeof makeFakeMutagenClient>[0] = {},
): { engine: ReturnType<typeof makeFileSyncEngine>; client: FakeMutagenClient } => {
  const client = makeFakeMutagenClient(initialState);
  return { engine: makeFileSyncEngine({ client }), client };
};

const runScoped = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.scoped(effect));
const runScopedExit = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.scoped(effect));

describe("@lando/file-sync-mutagen engine identity", () => {
  test("declares the spec-mandated engine id, display name, and capability matrix", () => {
    const { engine } = fakeEngine();
    expect(engine.id).toBe(ENGINE_ID);
    expect(engine.displayName).toBe(ENGINE_DISPLAY_NAME);
    expect(engine.capabilities).toEqual(mutagenCapabilities);
    expect(engine.capabilities.modes).toEqual([
      "two-way-safe",
      "two-way-resolved",
      "one-way-safe",
      "one-way-replica",
    ]);
    expect(engine.capabilities.remoteAgentDeployment).toBe("auto");
    expect(engine.capabilities.exclusionPatterns).toBe(true);
    expect(engine.capabilities.conflictReporting).toBe(true);
    expect(engine.capabilities.progressReporting).toBe(true);
  });

  test("isAvailable resolves true when the client reports a version", async () => {
    const { engine } = fakeEngine({ version: "0.18.3" });
    expect(await Effect.runPromise(engine.isAvailable)).toBe(true);
  });

  test("isAvailable resolves false when the client fails (unavailable default)", async () => {
    const engine = makeFileSyncEngine({ client: makeUnavailableMutagenClient("not installed") });
    expect(await Effect.runPromise(engine.isAvailable)).toBe(false);
  });

  test("default engine (no options) is the unavailable fail-closed engine", async () => {
    const engine = makeFileSyncEngine();
    expect(await Effect.runPromise(engine.isAvailable)).toBe(false);
    const exit = await runScopedExit(engine.createSession(buildSpec()));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(FileSyncStartError);
      }
    }
  });

  test("setup is a Scope-typed no-op", async () => {
    const { engine } = fakeEngine();
    await runScoped(engine.setup({ force: false }));
    await runScoped(engine.setup({ force: true }));
  });
});

describe("@lando/file-sync-mutagen engine create / pause / resume / terminate", () => {
  test("createSession derives the deterministic Mutagen name and delegates to the client", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec();
    const expectedName = mutagenSessionName(spec);

    await runScoped(
      Effect.gen(function* () {
        const ref = yield* engine.createSession(spec);
        expect(ref).toBe(expectedName as never);
        expect([...client.state.sessions.keys()]).toContain(expectedName);
        expect(client.state.calls.some((c) => c.op === "create" && c.name === expectedName)).toBe(true);
      }),
    );
  });

  test("createSession registers a scope finalizer that terminates the session", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ mountKey: "scope-cleanup" });
    const expectedName = mutagenSessionName(spec);

    await runScoped(
      Effect.gen(function* () {
        yield* engine.createSession(spec);
        const mid = client.state.sessions.get(expectedName);
        expect(mid?.status).toBe("running");
      }),
    );

    expect(client.state.sessions.has(expectedName)).toBe(false);
    expect(client.state.calls.some((c) => c.op === "terminate" && c.name === expectedName)).toBe(true);
  });

  test("createSession rejects sources outside the app root with FileSyncStartError", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ source: AbsolutePath.make("/etc") });
    const exit = await runScopedExit(engine.createSession(spec));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(FileSyncStartError);
        expect((failure.value as FileSyncStartError).remediation).toContain("app root");
      }
    }
    expect(client.state.calls.some((c) => c.op === "create")).toBe(false);
  });

  test("createSession surfaces FileSyncStartError when the client rejects (sentinel __REJECT__)", async () => {
    const { engine } = fakeEngine();
    const spec = buildSpec({ mountKey: MUTAGEN_FAKE_SENTINELS.rejectMountKey });
    const exit = await runScopedExit(engine.createSession(spec));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(FileSyncStartError);
      }
    }
  });

  test("pause + resume cycle is reflected in the status returned by listSessions", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ mountKey: "lifecycle" });
    const expectedName = mutagenSessionName(spec);

    await runScoped(
      Effect.gen(function* () {
        const ref = yield* engine.createSession(spec);

        let listed = yield* engine.listSessions({});
        expect(listed.find((info) => info.ref === ref)?.status).toBe("running");

        yield* engine.pauseSession(ref);
        listed = yield* engine.listSessions({});
        expect(listed.find((info) => info.ref === ref)?.status).toBe("paused");

        // Idempotent pause.
        yield* engine.pauseSession(ref);
        listed = yield* engine.listSessions({});
        expect(listed.find((info) => info.ref === ref)?.status).toBe("paused");

        yield* engine.resumeSession(ref);
        listed = yield* engine.listSessions({});
        expect(listed.find((info) => info.ref === ref)?.status).toBe("running");

        yield* engine.terminateSession(ref);
        listed = yield* engine.listSessions({});
        expect(listed.find((info) => info.ref === ref)).toBeUndefined();

        // Idempotent terminate.
        yield* engine.terminateSession(ref);
      }),
    );

    expect(client.state.calls.filter((c) => c.op === "pause").length).toBeGreaterThanOrEqual(2);
    expect(client.state.calls.filter((c) => c.op === "terminate").length).toBeGreaterThanOrEqual(2);
    expect(client.state.sessions.has(expectedName)).toBe(false);
  });

  test("terminateSession surfaces FileSyncStopError on the __STOP_FAIL__ sentinel", async () => {
    const { engine } = fakeEngine();
    const exit = await Effect.runPromiseExit(
      engine.terminateSession(FileSyncSessionRef.make(MUTAGEN_FAKE_SENTINELS.stopFailRef)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(FileSyncStopError);
      }
    }
  });
});

describe("@lando/file-sync-mutagen engine listSessions status polling", () => {
  test("polls the underlying client on every call (no cached state)", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ mountKey: "polled" });

    await runScoped(
      Effect.gen(function* () {
        yield* engine.createSession(spec);
        const callsBefore = client.state.calls.filter((c) => c.op === "list").length;
        yield* engine.listSessions({});
        yield* engine.listSessions({});
        yield* engine.listSessions({});
        const callsAfter = client.state.calls.filter((c) => c.op === "list").length;
        expect(callsAfter - callsBefore).toBe(3);
      }),
    );
  });

  test("reflects out-of-band status mutations (errored) on the next poll", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ mountKey: "errored" });
    const expectedName = mutagenSessionName(spec);

    await runScoped(
      Effect.gen(function* () {
        const ref = yield* engine.createSession(spec);

        const beforeErr = yield* engine.listSessions({});
        expect(beforeErr.find((info) => info.ref === ref)?.status).toBe("running");

        client.markErrored(expectedName, "fake fault");

        const afterErr = yield* engine.listSessions({});
        const erroredInfo = afterErr.find((info) => info.ref === ref);
        expect(erroredInfo?.status).toBe("errored");
        expect(erroredInfo?.detail).toBe("fake fault");
      }),
    );
  });

  test("applies app / service / mountKey filters", async () => {
    const { engine } = fakeEngine();
    const webSpec = buildSpec({ service: "web", mountKey: "src" });
    const apiSpec = buildSpec({ service: "api", mountKey: "src" });

    await runScoped(
      Effect.gen(function* () {
        yield* engine.createSession(webSpec);
        yield* engine.createSession(apiSpec);

        const onlyWeb = yield* engine.listSessions({ service: ServiceName.make("web") });
        expect(onlyWeb.map((info) => info.service)).toEqual([ServiceName.make("web")]);

        const onlyApiByMount = yield* engine.listSessions({
          service: ServiceName.make("api"),
          mountKey: "src",
        });
        expect(onlyApiByMount.map((info) => info.service)).toEqual([ServiceName.make("api")]);

        const noneByApp = yield* engine.listSessions({
          app: { kind: "user", id: AppId.make("other-app"), root: APP_ROOT },
        });
        expect(noneByApp).toHaveLength(0);
      }),
    );
  });
});

describe("@lando/file-sync-mutagen engine streamEvents", () => {
  test("streams an info chunk for a normal session ref", async () => {
    const { engine } = fakeEngine();
    const stream = engine.streamEvents(FileSyncSessionRef.make("any-name"));
    const chunks = await Effect.runPromise(Stream.runCollect(stream));
    const arr = [...chunks];
    expect(arr.length).toBeGreaterThanOrEqual(1);
    expect(arr[0]?._tag).toBe("info");
  });

  test("surfaces FileSyncDriftError on the __CONFLICT__ sentinel", async () => {
    const { engine } = fakeEngine();
    const stream = engine.streamEvents(FileSyncSessionRef.make(MUTAGEN_FAKE_SENTINELS.conflictRef));
    const exit = await Effect.runPromiseExit(Stream.runCollect(stream));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(FileSyncDriftError);
      }
    }
  });
});

describe("@lando/file-sync-mutagen fake state surfaces metadata", () => {
  test("createSession records the spec + sets a fresh lastUpdatedAt timestamp", async () => {
    const { engine, client } = fakeEngine();
    const spec = buildSpec({ mountKey: "metadata" });
    await runScoped(
      Effect.gen(function* () {
        yield* engine.createSession(spec);
        const record = client.state.sessions.get(mutagenSessionName(spec));
        expect(record).toBeDefined();
        expect(record?.spec).toBe(spec);
        expect(record?.lastUpdatedAt).toBeDefined();
        if (record?.lastUpdatedAt !== undefined) {
          expect(DateTime.isDateTime(record.lastUpdatedAt)).toBe(true);
        }
      }),
    );
  });
});
