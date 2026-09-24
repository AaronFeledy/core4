import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema } from "effect";

import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";

import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, type FileSyncSessionSpec, PortablePath, ServiceName } from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";

import {
  WINDOWS_LANDO_DOCKER_HOST,
  hasDurableMutagenOwnership,
  makeMutagenProcessClient,
  makePreparedWindowsMutagenProcessClient,
} from "../src/mutagen-process-client.ts";

const id = "sync_Abc123";
const name = "cms-web-app-root";
const source = "C:\\Users\\me\\CMS Project";
const helper = "lando-sync-helper-123";
const privateFileAccess = {
  enforce: async (_path: string) => undefined,
  verify: async (_path: string) => undefined,
};

const spec: FileSyncSessionSpec = {
  app: { kind: "user", id: AppId.make("cms"), root: AbsolutePath.make(source) },
  service: ServiceName.make("web"),
  mountKey: "app-root",
  source: AbsolutePath.make(source),
  target: { _tag: "volume", name: "lando-sync-cms", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [".git", "vendor"],
};

const session = (overrides: Record<string, unknown> = {}) => ({
  identifier: id,
  name,
  alpha: { protocol: "local", path: source, connected: true },
  beta: {
    protocol: "docker",
    host: helper,
    path: "/lando-data",
    environment: { DOCKER_HOST: "npipe:////./pipe/podman-lando", DOCKER_CONTEXT: "" },
    connected: true,
  },
  mode: "two-way-safe",
  ignore: { paths: [".git", "vendor"] },
  paused: false,
  status: "watching",
  successfulCycles: 1,
  ...overrides,
});

const fake = (
  options: {
    mismatch?: boolean;
    unhealthy?: boolean;
    preexisting?: boolean;
    failTerminate?: boolean;
    ambiguousId?: boolean;
    failCreateOnce?: boolean;
    failPauseOnce?: boolean;
    failTerminateOnce?: boolean;
    failTerminateAfterDeleteOnce?: boolean;
    betaEnvironment?: Readonly<Record<string, string>>;
    stateStore?: PluginStateStore;
  } = {},
) => {
  const calls: Array<{ args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = [];
  let sessions: Array<Record<string, unknown>> = options.preexisting ? [session()] : [];
  let failCreateOnce = options.failCreateOnce === true;
  let failPauseOnce = options.failPauseOnce === true;
  let failTerminateOnce = options.failTerminateOnce === true;
  let failTerminateAfterDeleteOnce = options.failTerminateAfterDeleteOnce === true;
  let targetResolutions = 0;
  const stateStore =
    options.stateStore ??
    makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/mutagen-process-client-test"),
      privateFileAccess,
    );
  const makeClient = (store: PluginStateStore = stateStore) =>
    makeMutagenProcessClient({
      stateStore: store,
      binDir: "C:\\lando\\bin",
      dataDir: "C:\\lando\\cache\\file-sync\\sessions",
      dockerCliPath: "C:\\lando\\runtime\\docker.exe",
      dockerHost: "npipe:////./pipe/podman-lando",
      platform: "win32",
      arch: "x64",
      verifyInstalled: async () => true,
      resolveTarget: () =>
        Effect.sync(() => {
          targetResolutions += 1;
          return { containerId: helper, path: "/lando-data" };
        }),
      runner: {
        run: ({ args, env }) =>
          Effect.sync(() => {
            calls.push({ args, env: env ?? {} });
            if (args[0] === "version") return { exitCode: 0, stdout: "Mutagen version 0.18.1", stderr: "" };
            if (args[1] === "list") return { exitCode: 0, stdout: JSON.stringify(sessions), stderr: "" };
            if (args[1] === "create") {
              if (failCreateOnce) {
                failCreateOnce = false;
                return { exitCode: 1, stdout: "", stderr: "create failed before session creation" };
              }
              const createdName = args[args.indexOf("--name") + 1] ?? name;
              const createdId = createdName === name ? id : "sync_New456";
              sessions = [
                session({
                  name: createdName,
                  identifier: createdId,
                  ...(options.mismatch
                    ? { beta: { protocol: "docker", host: "other", path: "/lando-data", connected: true } }
                    : options.betaEnvironment === undefined
                      ? {}
                      : {
                          beta: {
                            protocol: "docker",
                            host: helper,
                            path: "/lando-data",
                            connected: true,
                            environment: options.betaEnvironment,
                          },
                        }),
                }),
              ];
              return {
                exitCode: 0,
                stdout: options.ambiguousId
                  ? "Created session, ID unavailable\n"
                  : `Created session ${createdId}\n`,
                stderr: "",
              };
            }
            if (args[1] === "flush" && options.unhealthy)
              sessions = [session({ conflicts: [{ path: "README.md" }] })];
            if (args[1] === "pause") {
              sessions = sessions.map((entry) => ({ ...entry, paused: true }));
              if (failPauseOnce) {
                failPauseOnce = false;
                return { exitCode: 1, stdout: "", stderr: "pause interrupted" };
              }
            }
            if (args[1] === "resume") sessions = sessions.map((entry) => ({ ...entry, paused: false }));
            if (args[1] === "terminate") {
              if (options.failTerminate || failTerminateOnce) {
                failTerminateOnce = false;
                return { exitCode: 1, stdout: "", stderr: "sensitive target details" };
              }
              sessions = [];
              if (failTerminateAfterDeleteOnce) {
                failTerminateAfterDeleteOnce = false;
                return { exitCode: 1, stdout: "", stderr: "connection closed" };
              }
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      },
    });
  const client = makeClient();
  return {
    client,
    reopen: makeClient,
    stateStore,
    calls,
    targetResolutions: () => targetResolutions,
    current: () => sessions,
    setCurrent: (value: Array<Record<string, unknown>>) => {
      sessions = value;
    },
  };
};

describe("Mutagen process client", () => {
  test("creates by argv, inspects the unique ID and full config, and blocks on a healthy flush", async () => {
    const { client, calls } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["sync", "list"],
      ["sync", "create"],
      ["sync", "list"],
      ["sync", "list"],
      ["sync", "flush"],
      ["sync", "list"],
    ]);
    const create = calls.find((call) => call.args[1] === "create");
    expect(create).toBeDefined();
    if (create === undefined) throw new Error("Expected Mutagen create invocation.");
    expect(create.args).toContain(source);
    expect(create.args).toContain(`docker://${helper}/lando-data`);
    expect(create.args).toContain("--no-global-configuration");
    expect(create.args).toContain("--no-ignore-vcs");
    expect(create.env.MUTAGEN_DATA_DIRECTORY).toBe("C:\\lando\\cache\\file-sync\\sessions");
    expect(create.env.DOCKER_HOST).toBe("npipe:////./pipe/podman-lando");
    expect(create.env.MUTAGEN_DOCKER_PATH).toBe("C:\\lando\\runtime");
    expect(create.env.PATH?.split(";")[0]).toBe("C:\\lando\\runtime");
    const listed = await Effect.runPromise(client.list);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.spec).toEqual(spec);
    await Effect.runPromise(client.flush(name));
    expect(calls.filter((call) => call.args[1] === "flush").every((call) => call.args[2] === id)).toBe(true);
    await Effect.runPromise(client.terminate(name));
    expect(calls.some((call) => call.args.join(" ") === `sync terminate ${id}`)).toBe(true);
  });

  test("refuses a same-named session whose ownership cannot be proven", async () => {
    const { client, calls } = fake({ preexisting: true });
    const exit = await Effect.runPromiseExit(client.create({ name, spec }));
    expect(exit._tag).toBe("Failure");
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
    expect(calls.some((call) => call.args[1] === "terminate")).toBe(false);
  });

  test("leaves an unverified ID untouched if inspection detects a changed endpoint", async () => {
    const { client, calls, current } = fake({ mismatch: true });
    const exit = await Effect.runPromiseExit(client.create({ name, spec }));
    expect(exit._tag).toBe("Failure");
    expect(calls.some((call) => call.args[1] === "terminate")).toBe(false);
    expect(current()).toHaveLength(1);
  });

  test("fails readiness on conflicts and cleans up the exact new session", async () => {
    const { client, calls } = fake({ unhealthy: true });
    const exit = await Effect.runPromiseExit(client.create({ name, spec }));
    expect(exit._tag).toBe("Failure");
    expect(calls.map((call) => call.args[1]).slice(-2)).toEqual(["list", "terminate"]);
  });
  test("rejects a persisted Docker host or context that points away from the selected runtime", async () => {
    for (const betaEnvironment of [
      { DOCKER_HOST: "npipe:////./pipe/another-engine", DOCKER_CONTEXT: "" },
      { DOCKER_HOST: "npipe:////./pipe/podman-lando", DOCKER_CONTEXT: "remote" },
      { DOCKER_HOST: "npipe:////./pipe/podman-lando" },
    ]) {
      const { client, calls } = fake({ betaEnvironment });
      const exit = await Effect.runPromiseExit(client.create({ name, spec }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls.some((call) => call.args[1] === "flush")).toBe(false);
      expect(calls.some((call) => call.args[1] === "terminate")).toBe(false);
    }
  });

  test("reports the exact ID when readiness cleanup fails, without leaking daemon stderr", async () => {
    const { client, current } = fake({ unhealthy: true, failTerminate: true });
    const exit = await Effect.runPromiseExit(client.create({ name, spec }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value.message).toContain(id);
        expect(failure.value.message).toContain("cleanup failed");
        expect(failure.value.message).not.toContain("sensitive target details");
      }
    }
    expect(current()).toHaveLength(1);
  });

  test("recovers a committed session across clients and removes its receipt after verified termination", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-mutagen-ledger-"));
    try {
      const firstState = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const { client, reopen, calls } = fake({ stateStore: firstState });
      await Effect.runPromise(client.create({ name, spec }));
      const secondState = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const second = reopen(secondState);
      expect((await Effect.runPromise(second.list)).map((item) => item.name)).toEqual([name]);
      await Effect.runPromise(second.create({ name, spec }));
      expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
      await Effect.runPromise(second.terminate(name));
      expect(await Effect.runPromise(reopen().list)).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("unknown ledger versions block creation without touching daemon sessions or durable state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-mutagen-unknown-ledger-"));
    try {
      const stateStore = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const unknown = await Effect.runPromise(
        stateStore.open({
          namespace: "sessions",
          key: "mutagen.json",
          schema: Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }),
          version: 99,
          codec: "json",
        }),
      );
      const original = { sessions: [{ legacy: "unrecognized ownership" }] };
      await Effect.runPromise(unknown.set(original));
      const { client, calls, targetResolutions } = fake({ stateStore });

      const ownership = await Effect.runPromiseExit(hasDurableMutagenOwnership(stateStore));
      expect(Exit.isFailure(ownership)).toBe(true);
      if (Exit.isFailure(ownership)) {
        const failure = Cause.failureOption(ownership.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") expect(failure.value.message).toContain("unknown version");
      }
      expect(Exit.isFailure(await Effect.runPromiseExit(client.create({ name, spec })))).toBe(true);
      expect(Exit.isFailure(await Effect.runPromiseExit(client.list))).toBe(true);
      expect(Exit.isFailure(await Effect.runPromiseExit(client.terminate(name)))).toBe(true);
      expect(calls).toEqual([]);
      expect(targetResolutions()).toBe(0);
      expect(await Effect.runPromise(unknown.get)).toEqual(original);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a version change blocks reuse and termination of a previously owned session", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-mutagen-version-change-"));
    try {
      const stateStore = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const { client, reopen, calls, current } = fake({ stateStore });
      await Effect.runPromise(client.create({ name, spec }));
      const previous = await Effect.runPromise(
        stateStore.open({
          namespace: "sessions",
          key: "mutagen.json",
          schema: Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }),
          version: 1,
          codec: "json",
        }),
      );
      const original = await Effect.runPromise(previous.get);
      expect(original?.sessions).toHaveLength(1);
      if (original === null) throw new Error("Expected a committed ownership receipt.");
      const unknown = await Effect.runPromise(
        stateStore.open({
          namespace: "sessions",
          key: "mutagen.json",
          schema: Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }),
          version: 99,
          codec: "json",
        }),
      );
      await Effect.runPromise(unknown.set(original));
      const before = calls.length;

      expect(Exit.isFailure(await Effect.runPromiseExit(reopen().create({ name, spec })))).toBe(true);
      expect(Exit.isFailure(await Effect.runPromiseExit(reopen().terminate(name)))).toBe(true);
      expect(Exit.isFailure(await Effect.runPromiseExit(reopen().drainApp(spec.app)))).toBe(true);
      expect(Exit.isFailure(await Effect.runPromiseExit(reopen().disposeApp(spec.app)))).toBe(true);
      expect(calls).toHaveLength(before);
      expect(current()).toHaveLength(1);
      expect(await Effect.runPromise(unknown.get)).toEqual(original);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
  test("ownership query reads durable receipts without running Mutagen", async () => {
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/mutagen-ownership-query"),
      privateFileAccess,
    );
    const { client, calls } = fake({ stateStore });
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore))).toBe(false);
    await Effect.runPromise(client.create({ name, spec }));
    const before = calls.length;
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore))).toBe(true);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    expect(
      await Effect.runPromise(
        hasDurableMutagenOwnership(stateStore, { ...spec.app, id: AppId.make("other") }),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(before);
  });

  test("a daemon session without a receipt makes list fail closed", async () => {
    const { client, calls } = fake({ preexisting: true });
    expect(Exit.isFailure(await Effect.runPromiseExit(client.list))).toBe(true);
    expect(calls.some((call) => call.args[1] === "terminate")).toBe(false);
  });

  test("retries a failed create from a fresh client after proving daemon absence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-mutagen-retry-"));
    try {
      const firstState = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const { client, reopen, calls } = fake({ failCreateOnce: true, stateStore: firstState });
      expect(Exit.isFailure(await Effect.runPromiseExit(client.create({ name, spec })))).toBe(true);
      expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
      const secondState = makePluginStateStore(
        makeStateStore({ privateFileAccess }),
        AbsolutePath.make(stateDir),
        privateFileAccess,
      );
      const fresh = reopen(secondState);
      expect(await Effect.runPromise(fresh.list)).toEqual([]);
      await Effect.runPromise(fresh.create({ name, spec }));
      expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(2);
      expect((await Effect.runPromise(fresh.list)).map((item) => item.name)).toEqual([name]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("retains an incomplete preparing receipt after an ambiguous create result", async () => {
    const { client, reopen, calls, current } = fake({ ambiguousId: true });
    expect(Exit.isFailure(await Effect.runPromiseExit(client.create({ name, spec })))).toBe(true);
    expect(current()).toHaveLength(1);
    expect(Exit.isFailure(await Effect.runPromiseExit(reopen().list))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(reopen().create({ name, spec })))).toBe(true);
    expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
    expect(calls.some((call) => call.args[1] === "terminate")).toBe(false);
  });

  test("rejects changed daemon metadata on a recovered receipt before mutation", async () => {
    const { client, reopen, calls, setCurrent } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    setCurrent([session({ identifier: "sync_Foreign" })]);
    expect(Exit.isFailure(await Effect.runPromiseExit(reopen().flush(name)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(reopen().terminate(name)))).toBe(true);
    expect(calls.filter((call) => call.args[1] === "terminate")).toHaveLength(0);
  });

  test("first start invalidation leaves an empty ledger ready for create and drain", async () => {
    const { client, calls } = fake();
    await Effect.runPromise(client.invalidateAppDrain(spec.app));
    expect(calls).toEqual([]);
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(1);
    expect(calls.filter((call) => call.args[1] === "pause")).toHaveLength(1);
  });

  test("a restart can replace a drained session set after invalidation", async () => {
    const { client, calls, current } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    await Effect.runPromise(client.invalidateAppDrain(spec.app));
    await Effect.runPromise(client.terminate(name));
    const replacementName = "cms-web-replacement";
    await Effect.runPromise(client.create({ name: replacementName, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(current()[0]?.identifier).toBe("sync_New456");
    expect(current()[0]?.paused).toBe(true);
    expect(calls.filter((call) => call.args[1] === "flush").at(-1)?.args[2]).toBe("sync_New456");
  });

  test("invalidation refuses a stale drain with no sessions", async () => {
    const { client, stateStore, calls } = fake();
    const ledger = await Effect.runPromise(
      stateStore.open({
        namespace: "sessions",
        key: "mutagen.json",
        schema: Schema.Unknown,
        version: 1,
        codec: "json",
      }),
    );
    await Effect.runPromise(
      ledger.set({
        sessions: [],
        appDrains: [{ app: spec.app, phase: "drained", identifiers: [id] }],
      }),
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(client.invalidateAppDrain(spec.app)))).toBe(true);
    expect(calls).toEqual([]);
  });

  test("drained state blocks direct mutation before resolver or daemon calls", async () => {
    const { client, calls, targetResolutions, current, stateStore } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    const before = calls.length;
    const resolutions = targetResolutions();
    expect(Exit.isFailure(await Effect.runPromiseExit(client.create({ name, spec })))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.flush(name)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.pause(name)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.resume(name)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.terminate(name)))).toBe(true);
    expect(calls).toHaveLength(before);
    expect(targetResolutions()).toBe(resolutions);
    expect(current()[0]?.paused).toBe(true);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    await Effect.runPromise(client.invalidateAppDrain(spec.app));
    await Effect.runPromise(client.resume(name));
    expect(calls.at(-1)?.args).toEqual(["sync", "resume", id]);
  });

  test("repeated app drains resume, reflush, and pause the exact ID", async () => {
    const { client, calls, current } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.invalidateAppDrain(spec.app));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(current()[0]?.paused).toBe(true);
    const before = calls.length;
    await Effect.runPromise(client.drainApp(spec.app));
    expect(
      calls
        .slice(before)
        .filter((call) => call.args[1] === "resume")
        .map((call) => call.args[2]),
    ).toEqual([id]);
    expect(
      calls
        .slice(before)
        .filter((call) => call.args[1] === "flush")
        .map((call) => call.args[2]),
    ).toEqual([id]);
    expect(current()[0]?.paused).toBe(true);
  });

  test("a pause interrupted after mutation leaves preparing state and a later drain retries", async () => {
    const { client, reopen, calls, current } = fake({ failPauseOnce: true });
    await Effect.runPromise(client.create({ name, spec }));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.drainApp(spec.app)))).toBe(true);
    expect(current()[0]?.paused).toBe(true);
    await Effect.runPromise(reopen().drainApp(spec.app));
    expect(calls.filter((call) => call.args[1] === "flush")).toHaveLength(3);
    expect(current()[0]?.paused).toBe(true);
  });

  test("partial disposal retains exact ID and retries without losing ownership", async () => {
    const { client, reopen, stateStore, calls, current } = fake({ failTerminateOnce: true });
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    expect(current()).toHaveLength(1);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    await Effect.runPromise(reopen().disposeApp(spec.app));
    expect(current()).toHaveLength(0);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    await Effect.runPromise(reopen().completeAppDisposal(spec.app));
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(false);
    expect(calls.filter((call) => call.args[1] === "terminate").map((call) => call.args[2])).toEqual([
      id,
      id,
    ]);
  });

  test("disposal rechecks paused health before marking or terminating", async () => {
    const { client, calls, current, setCurrent, stateStore } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    const before = calls.length;
    setCurrent([session({ paused: false })]);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    setCurrent([session({ paused: true, conflicts: [{ path: "README.md" }] })]);
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    expect(calls.slice(before).some((call) => call.args[1] === "terminate")).toBe(false);
    expect(current()).toHaveLength(1);
    const ledger = await Effect.runPromise(
      stateStore.open({
        namespace: "sessions",
        key: "mutagen.json",
        schema: Schema.Unknown,
        version: 1,
        codec: "json",
      }),
    );
    const value = (await Effect.runPromise(ledger.get)) as {
      appDrains: Array<{ phase: string }>;
    };
    expect(value.appDrains[0]?.phase).toBe("drained");
  });

  test("disposal refuses undrained and invalidated app sessions", async () => {
    const { client, calls, current } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    const before = calls.length;
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    await Effect.runPromise(client.invalidateAppDrain(spec.app));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    expect(calls.slice(before).some((call) => call.args[1] === "terminate")).toBe(false);
    expect(current()).toHaveLength(1);
  });

  test("invalidation refuses an app already disposing", async () => {
    const { client, stateStore, calls } = fake({ failTerminateOnce: true });
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    const before = calls.length;
    expect(Exit.isFailure(await Effect.runPromiseExit(client.invalidateAppDrain(spec.app)))).toBe(true);
    expect(calls).toHaveLength(before);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
  });

  test("invalidation refuses a stale drained identifier set", async () => {
    const { client, stateStore, calls } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    const ledger = await Effect.runPromise(
      stateStore.open({
        namespace: "sessions",
        key: "mutagen.json",
        schema: Schema.Unknown,
        version: 1,
        codec: "json",
      }),
    );
    const value = (await Effect.runPromise(ledger.get)) as {
      sessions: unknown[];
      appDrains: Array<{ app: FileSyncSessionSpec["app"]; phase: string; identifiers: string[] }>;
    };
    await Effect.runPromise(
      ledger.set({
        ...value,
        appDrains: value.appDrains.map((entry) => ({ ...entry, identifiers: ["sync_Stale"] })),
      }),
    );
    const before = calls.length;
    expect(Exit.isFailure(await Effect.runPromiseExit(client.invalidateAppDrain(spec.app)))).toBe(true);
    expect(calls).toHaveLength(before);
  });

  test("empty app drain refuses to mint a drained receipt", async () => {
    const { client, calls } = fake();
    expect(Exit.isFailure(await Effect.runPromiseExit(client.drainApp(spec.app)))).toBe(true);
    expect(calls.some((call) => call.args[1] === "flush")).toBe(false);
  });

  test("disposal recovers an exact ID terminated before command acknowledgment", async () => {
    const { client, reopen, stateStore, calls, current } = fake({
      failTerminateAfterDeleteOnce: true,
    });
    await Effect.runPromise(client.create({ name, spec }));
    await Effect.runPromise(client.drainApp(spec.app));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.disposeApp(spec.app)))).toBe(true);
    expect(current()).toHaveLength(0);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    await Effect.runPromise(reopen().disposeApp(spec.app));
    expect(calls.filter((call) => call.args[1] === "terminate")).toHaveLength(1);
    await Effect.runPromise(reopen().completeAppDisposal(spec.app));
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(false);
  });

  test("drain refuses a changed exact ID before any resume, flush, or pause", async () => {
    const { client, calls, setCurrent } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    setCurrent([session({ identifier: "sync_Foreign" })]);
    const before = calls.length;
    expect(Exit.isFailure(await Effect.runPromiseExit(client.drainApp(spec.app)))).toBe(true);
    expect(calls.slice(before).every((call) => call.args[1] === "list")).toBe(true);
  });

  test("completion refuses live IDs and tombstones stay durable after disposal", async () => {
    const { client, reopen, stateStore, setCurrent } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    expect(Exit.isFailure(await Effect.runPromiseExit(client.completeAppDisposal(spec.app)))).toBe(true);
    await Effect.runPromise(client.drainApp(spec.app));
    await Effect.runPromise(client.disposeApp(spec.app));
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
    setCurrent([session()]);
    expect(Exit.isFailure(await Effect.runPromiseExit(reopen().completeAppDisposal(spec.app)))).toBe(true);
    expect(await Effect.runPromise(hasDurableMutagenOwnership(stateStore, spec.app))).toBe(true);
  });

  test("neutralizes a daemon error before returning session detail", async () => {
    const { client, setCurrent } = fake();
    await Effect.runPromise(client.create({ name, spec }));
    setCurrent([session({ lastError: "password=my-secret-token" })]);
    const listed = await Effect.runPromise(client.list);
    expect(listed[0]?.status).toBe("errored");
    expect(listed[0]?.detail).toContain("Mutagen reported");
    expect(listed[0]?.detail).not.toContain("my-secret-token");
  });
});

describe("prepared Windows Mutagen transport", () => {
  const alias = "C:\\Lando\\runtime\\docker-compat\\docker.exe";
  const makeOptions = (
    prepareDockerCli: () => Effect.Effect<string, unknown>,
    calls: Array<Readonly<Record<string, string>>>,
  ) => ({
    binDir: "C:\\Lando\\bin",
    dataDir: "C:\\Lando\\mutagen-data",
    stateStore: makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/mutagen-windows-transport-test"),
      privateFileAccess,
    ),
    verifyInstalled: async () => true,
    prepareDockerCli,
    resolveTarget: () => Effect.succeed({ containerId: helper, path: "/lando-data" }),
    runner: {
      run: ({ env }: { env?: Readonly<Record<string, string>> }) =>
        Effect.sync(() => {
          calls.push(env ?? {});
          return { exitCode: 0, stdout: "Mutagen version 0.18.1", stderr: "" };
        }),
    },
  });

  test("routes only the Mutagen child through the prepared alias and owned Podman pipe", async () => {
    const calls: Array<Readonly<Record<string, string>>> = [];
    const inheritedPath = process.env.PATH;
    let preparations = 0;
    const client = await Effect.runPromise(
      makePreparedWindowsMutagenProcessClient(
        makeOptions(
          () =>
            Effect.sync(() => {
              preparations += 1;
              return alias;
            }),
          calls,
        ),
      ),
    );
    expect(await Effect.runPromise(client.version)).toBe("0.18.1");
    expect(await Effect.runPromise(client.version)).toBe("0.18.1");
    expect(preparations).toBe(3);
    expect(calls).toHaveLength(2);
    for (const env of calls) {
      expect(env.MUTAGEN_DOCKER_PATH).toBe("C:\\Lando\\runtime\\docker-compat");
      expect(env.PATH?.split(";")[0]).toBe("C:\\Lando\\runtime\\docker-compat");
      expect(env.DOCKER_HOST).toBe(WINDOWS_LANDO_DOCKER_HOST);
      expect(env.DOCKER_CONTEXT).toBe("");
      expect(env.MUTAGEN_DATA_DIRECTORY).toBe("C:\\Lando\\mutagen-data");
    }
    expect(process.env.PATH).toBe(inheritedPath);
  });

  test("fails before spawning when preparation is missing, redirected, or later changes", async () => {
    const calls: Array<Readonly<Record<string, string>>> = [];
    for (const badPath of ["docker.exe", "C:\\Lando\\runtime\\podman.exe"]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            makePreparedWindowsMutagenProcessClient(makeOptions(() => Effect.succeed(badPath), calls)),
          ),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          makePreparedWindowsMutagenProcessClient(
            makeOptions(() => Effect.fail(new Error("managed runtime missing")), calls),
          ),
        ),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(0);

    let current = alias;
    const client = await Effect.runPromise(
      makePreparedWindowsMutagenProcessClient(makeOptions(() => Effect.succeed(current), calls)),
    );
    expect(await Effect.runPromise(client.version)).toBe("0.18.1");
    current = "C:\\Other\\docker.exe";
    expect(Exit.isFailure(await Effect.runPromiseExit(client.version))).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
