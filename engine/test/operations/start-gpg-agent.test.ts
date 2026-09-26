import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, type AppPlan, ServiceName } from "@lando/sdk/schema";
import {
  PathsService,
  ProcessRunner,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { PrivateFileAccessLive, type PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Stream } from "effect";
import * as gpgAgentModule from "../../src/operations/start-gpg-agent.ts";
import { startGpgAgentSession, withStartedGpgAgent } from "../../src/operations/start-gpg-agent.ts";
import { startApp } from "../../src/operations/start.ts";
import type { DetachedWorkerSpawnSpec } from "../../src/subsystems/detached-worker/process.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/gpg-agent/intent.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import type { AgentRelayWorkerReady } from "../../src/subsystems/ssh-agent/worker-protocol.ts";
import { app, plan } from "../subsystems/gpg-agent/fixture.ts";
import * as topology from "./start-progress-topology-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const run = <A, E>(effect: Effect.Effect<A, E, PathsService | PrivateFileAccessService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(PathsService, makeLandoPaths()), Effect.provide(PrivateFileAccessLive)),
  );

const exec: RuntimeProviderShape["exec"] = () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });

test("gpg forwarding skips when forward is false", async () => {
  // Given
  // When
  const result = await run(
    withStartedGpgAgent(plan, app, {}, { forward: false }, { exec, use: Effect.succeed }),
  );
  // Then
  expect(result).toBe(plan);
});

test("gpg capability-missing fails before apply", async () => {
  // Given
  let applied = false;
  // When
  const result = await run(
    Effect.either(
      withStartedGpgAgent(
        plan,
        app,
        {},
        { forward: true },
        {
          exec,
          use: () =>
            Effect.sync(() => {
              applied = true;
            }),
        },
      ),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "GpgAgentUnavailableError", reason: "capability-missing" },
  });
  expect(applied).toBe(false);
});

test("gpg overlays eligible services and closes the session on use failure", async () => {
  // Given
  let closed = false;
  const session: AgentRelaySession = {
    appId: plan.id,
    sessionId: "test",
    kind: "gpg",
    socketName: "S.gpg-agent",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    closed: Promise.resolve(),
    close: async () => {
      closed = true;
    },
  };
  // When
  await run(
    Effect.either(
      withStartedGpgAgent(
        plan,
        app,
        { agentSocket: { delivery: "bind-directory" } },
        { forward: true },
        {
          exec,
          startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
          use: (overlaid) => {
            expect(overlaid.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
            expect(overlaid.services[ServiceName.make("web")]?.environment.GNUPGHOME).toBe(
              "/run/lando/gnupg",
            );
            return Effect.fail("apply failed");
          },
        },
      ),
    ),
  );
  // Then
  expect(closed).toBe(true);
});

test("gpg home preparation runs only when the caller invokes it after apply", async () => {
  // Given
  const calls: string[] = [];
  const session: AgentRelaySession = {
    appId: plan.id,
    sessionId: "no-prepare",
    kind: "gpg",
    socketName: "S.gpg-agent",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    closed: Promise.resolve(),
    close: async () => undefined,
  };
  // When
  await run(
    withStartedGpgAgent(
      plan,
      app,
      { agentSocket: { delivery: "bind-directory" } },
      { forward: true },
      {
        exec: () =>
          Effect.sync(() => {
            calls.push("exec");
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
        startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
        use: () => Effect.sync(() => calls.push("apply")),
      },
    ),
  );
  // Then
  expect(calls).toEqual(["apply"]);
});

for (const exitCode of [0, 1]) {
  test(`gpg initializes each service right after apply on every start and fails closed for exit ${exitCode}`, async () => {
    // Given
    const web = plan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("missing web fixture");
    const selected: AppPlan = {
      ...plan,
      services: {
        ...plan.services,
        [web.name]: { ...web, user: "1001:1001" },
        [ServiceName.make("worker")]: { ...web, name: ServiceName.make("worker"), user: "app" },
      },
    };
    const calls: string[] = [];
    let closed = 0;
    const session: AgentRelaySession = {
      appId: plan.id,
      sessionId: "same-session",
      kind: "gpg",
      socketName: "S.gpg-agent",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
      closed: Promise.resolve(),
      close: async () => {
        closed += 1;
      },
    };
    const initialize: RuntimeProviderShape["exec"] = (target, command) =>
      Effect.sync(() => {
        calls.push(`${target.service}:${target.user}`);
        expect(target.app).toBe(plan.id);
        expect(command.command.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(command.command[2]).toContain("--import-ownertrust");
        expect(command.command[2]).toContain('"$GNUPGHOME/S.gpg-agent"');
        return { exitCode, stdout: "", stderr: "private diagnostic" };
      });
    const start = withStartedGpgAgent(
      selected,
      app,
      { agentSocket: { delivery: "bind-directory" } },
      { forward: true },
      {
        exec: initialize,
        startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
        use: (_, prepareGpgHome) =>
          Effect.sync(() => {
            calls.push("apply");
          }).pipe(
            Effect.zipRight(prepareGpgHome),
            Effect.tap(() => Effect.sync(() => calls.push("routes"))),
          ),
      },
    );
    // When
    const results = await run(Effect.all([Effect.either(start), Effect.either(start)]));
    // Then
    if (exitCode === 0) {
      expect(calls).toEqual([
        "apply",
        "web:1001:1001",
        "worker:app",
        "routes",
        "apply",
        "web:1001:1001",
        "worker:app",
        "routes",
      ]);
      expect(results.map((result) => result._tag)).toEqual(["Right", "Right"]);
      expect(closed).toBe(0);
    } else {
      expect(calls).toEqual(["apply", "web:1001:1001", "apply", "web:1001:1001"]);
      for (const result of results) {
        expect(result).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "GpgAgentTransportError",
            stage: "worker",
            remediation: expect.stringMatching(/install.*gpg.*image/i),
          },
        });
        expect(JSON.stringify(result)).not.toContain("private diagnostic");
      }
      expect(closed).toBe(2);
    }
  });
}

const fakeGnuPg = (exportExit: number): ProcessRunner["Type"] => ({
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => Stream.empty,
  streamWithExit: ({ cmd, args }) =>
    Stream.make(
      { kind: "stdout" as const, chunk: new TextEncoder().encode(`${cmd} ${args.join(" ")}`) },
      { exitCode: exportExit },
    ),
});
const fakeWorker = (stateDir: string, terminated: { count: number }) => (spec: DetachedWorkerSpawnSpec) => ({
  pid: 4242,
  argv: spec.argv,
  writeStdin: async () => undefined,
  readReady: async (): Promise<AgentRelayWorkerReady> => ({
    _tag: "ready",
    appId: plan.id,
    appRoot: plan.root,
    sessionId: "gpg-session",
    kind: "gpg",
    protocolVersion: 1,
    pid: 4242,
    controlToken: "token",
    controlPort: 1,
    socketName: "S.gpg-agent",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(stateDir, "socket")) },
  }),
  terminate: async () => {
    terminated.count += 1;
  },
});
const sessionOptions = (stateDir: string, terminated: { count: number }) => ({
  spawnWorker: fakeWorker(stateDir, terminated),
  discovery: {
    inspectPath: async () => "socket" as const,
    probeRestricted: async () => "restricted" as const,
  },
});

test("startGpgAgentSession leaves the exported keyring on disk once the worker owns its state", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-session-"));
  const paths = makeLandoPaths({ userDataRoot: root, platform: "linux" });
  const stateDir = paths.agentRelayRunDir("gpg", plan.id, plan.root);
  const terminated = { count: 0 };
  try {
    // When
    const agent = await Effect.runPromise(
      startGpgAgentSession(
        plan,
        app,
        { agentSocket: { delivery: "bind-directory" } },
        { forward: true, socket: "/host/S.gpg-agent.extra" },
        sessionOptions(stateDir, terminated),
      ).pipe(
        Effect.provideService(ProcessRunner, fakeGnuPg(0)),
        Effect.provideService(PathsService, paths),
        Effect.provide(PrivateFileAccessLive),
      ),
    );
    // Then
    expect(agent.session.mount).toEqual({
      _tag: "bind-directory",
      directory: AbsolutePath.make(join(stateDir, "socket")),
    });
    expect(await readFile(join(agent.keyringDir, "pubring.gpg"), "utf8")).toBe("gpg --batch --export");
    expect(await readFile(join(agent.keyringDir, "otrust.txt"), "utf8")).toBe(
      "gpg --batch --export-ownertrust",
    );
    expect(terminated.count).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startGpgAgentSession terminates the worker when the keyring export fails", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-session-"));
  const paths = makeLandoPaths({ userDataRoot: root, platform: "linux" });
  const terminated = { count: 0 };
  try {
    // When
    const result = await Effect.runPromise(
      Effect.either(
        startGpgAgentSession(
          plan,
          app,
          { agentSocket: { delivery: "bind-directory" } },
          { forward: true, socket: "/host/S.gpg-agent.extra" },
          sessionOptions(paths.agentRelayRunDir("gpg", plan.id, plan.root), terminated),
        ),
      ).pipe(
        Effect.provideService(ProcessRunner, fakeGnuPg(2)),
        Effect.provideService(PathsService, paths),
        Effect.provide(PrivateFileAccessLive),
      ),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "GpgAgentUnavailableError", reason: "gpg-missing" },
    });
    expect(terminated.count).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const prepareExit of [0, 1]) {
  test(`full start prepares GNUPGHOME inside the apply transaction (exit ${prepareExit})`, async () => {
    // Given
    const selected: AppPlan = {
      ...topology.plan,
      extensions: { [GPG_AGENT_PLAN_EXTENSION_KEY]: { forward: true } },
      services: {
        [topology.web.name]: {
          ...topology.web,
          extensions: { [GPG_AGENT_PLAN_EXTENSION_KEY]: { forward: true } },
        },
      },
    };
    const calls: string[] = [];
    const harness = makeHarness({
      plannedApp: selected,
      onApply: () => calls.push("apply"),
      onBuildApp: () => calls.push("build-app"),
      afterApplyRoutes: Effect.sync(() => calls.push("routes")),
      onRemoveRoutes: () => calls.push("remove-routes"),
      onDestroy: () => calls.push("destroy"),
      onPublish: (event) =>
        Effect.sync(() => {
          if (event._tag === "post-start") calls.push("post-start");
        }),
    });
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
    let closed = 0;
    const gpgSession = spyOn(gpgAgentModule, "startGpgAgentSession").mockImplementation(() =>
      Effect.succeed({
        session: {
          appId: selected.id,
          sessionId: "gpg-start-session",
          kind: "gpg",
          socketName: "S.gpg-agent",
          mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/gpg-socket") },
          closed: Promise.resolve(),
          close: async () => {
            closed += 1;
          },
        },
        keyringDir: "/relay/gpg-keyring",
      }),
    );
    try {
      // When
      const result = await Effect.runPromise(
        Effect.either(
          startApp(
            {},
            {
              plan: selected,
              root: selected.root,
              app: { kind: "user", id: selected.id, root: selected.root },
              landofile: { name: selected.name, services: {}, gpgAgent: { forward: true } },
            },
          ),
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...provider,
                capabilities: { ...provider.capabilities, agentSocket: { delivery: "bind-directory" } },
                exec: () =>
                  Effect.sync(() => {
                    calls.push("gpg-prepare");
                    return { exitCode: prepareExit, stdout: "", stderr: "" };
                  }),
              }),
          }),
          Effect.provide(harness.layer),
        ),
      );
      // Then
      if (prepareExit === 0) {
        expect(result._tag).toBe("Right");
        expect(calls).toEqual(["apply", "gpg-prepare", "build-app", "routes", "post-start"]);
        expect(closed).toBe(0);
      } else {
        expect(result).toMatchObject({
          _tag: "Left",
          left: { _tag: "GpgAgentTransportError", stage: "worker" },
        });
        expect(calls).toEqual(["apply", "gpg-prepare", "destroy"]);
        expect(closed).toBe(1);
      }
    } finally {
      gpgSession.mockRestore();
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}
