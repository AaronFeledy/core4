import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeLandoPaths } from "@lando/paths";
import type {
  GpgAgentTransportError,
  GpgAgentUnavailableError,
  SshAgentTransportError,
  SshAgentUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { type EventService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { startApp } from "../../src/operations/start.ts";
import * as gpgAgentModule from "../../src/operations/start-gpg-agent.ts";
import { withStartedGpgAgent } from "../../src/operations/start-gpg-agent.ts";
import * as sshAgentModule from "../../src/operations/start-ssh-agent.ts";
import { withStartedSshAgent } from "../../src/operations/start-ssh-agent.ts";
import * as EventServiceImplementation from "../../src/services/event-service.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { app, plan } from "../subsystems/gpg-agent/fixture.ts";
import { makeHarness, plan as topologyPlan, web as topologyWeb } from "./start-progress-topology-support.ts";
import { writeAgentRelayWorker } from "./start-worker-retirement-support.ts";

const selected = {
  ...plan,
  services: Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      {
        ...service,
        extensions: { ...service.extensions, "@lando/core/ssh-agent": { mode: "host" } },
      },
    ]),
  ),
};

const topologyApp = { kind: "user" as const, id: topologyPlan.id, root: topologyPlan.root };

const removeHarness = (harness: ReturnType<typeof makeHarness>) =>
  rm(harness.userDataRoot, { recursive: true, force: true });

for (const kind of ["ssh", "gpg"] as const) {
  for (const outcome of ["defect", "interrupted"] as const) {
    test(`${kind} retains on ${outcome} until the managed scope closes`, async () => {
      // Given
      const scope = await Effect.runPromise(Scope.make());
      const entered = Deferred.makeUnsafe<void>();
      const defect = new TypeError("apply defect");
      let closed = 0;
      const session: AgentRelaySession = {
        appId: selected.id,
        sessionId: "agent-session",
        kind,
        socketName: kind === "ssh" ? "agent.sock" : "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
        closed: Promise.resolve(),
        close: async () => {
          closed++;
        },
      };
      const use = () => {
        switch (outcome) {
          case "defect":
            return Effect.die(defect);
          case "interrupted":
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          default:
            return outcome satisfies never;
        }
      };
      const operation: Effect.Effect<
        never,
        SshAgentTransportError | SshAgentUnavailableError | GpgAgentTransportError | GpgAgentUnavailableError,
        PathsService | PrivateFileAccessService | EventService
      > =
        kind === "ssh"
          ? withStartedSshAgent(
              selected,
              app,
              {},
              { mode: "host" },
              {
                managed: { scope },
                startSession: () => Effect.succeed(session),
                use,
              },
            )
          : withStartedGpgAgent(
              selected,
              app,
              {},
              { forward: true },
              {
                managed: { scope },
                startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
                exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
                use,
              },
            );
      // When
      const fiber = Effect.runFork(
        operation.pipe(
          Effect.provideService(PathsService, makeLandoPaths()),
          Effect.provide(PrivateFileAccessService.layer),
          Effect.provide(EventServiceImplementation.layer),
        ),
      );
      if (outcome === "interrupted") {
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      const exit = await Effect.runPromise(Fiber.await(fiber));
      const closedBeforeScope = closed;
      await Effect.runPromise(Scope.close(scope, Exit.void));
      // Then
      expect(closed).toBe(1);
      expect(closedBeforeScope).toBe(0);
      switch (outcome) {
        case "defect":
          expect(exit).toEqual(Exit.die(defect));
          break;
        case "interrupted":
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          break;
        default:
          outcome satisfies never;
      }
    });
  }
}

for (const kind of ["ssh", "gpg"] as const) {
  test(`a whole-app start retires an unused ${kind} agent relay`, async () => {
    // Given an app whose plan has no eligible service and its recorded relay.
    const harness = makeHarness();
    const recordPath = await writeAgentRelayWorker(harness, topologyApp, kind);
    try {
      expect(await Bun.file(recordPath).exists()).toBe(true);
      // When the whole app starts.
      await Effect.runPromise(
        startApp({}, { plan: topologyPlan, root: topologyPlan.root, app: topologyApp }).pipe(
          Effect.provide(harness.layer),
        ),
      );
      // Then the recorded relay and its run-directory state are gone.
      expect(await Bun.file(recordPath).exists()).toBe(false);
    } finally {
      await removeHarness(harness);
    }
  });

  test(`a selected rebuild leaves the recorded ${kind} agent relay alone`, async () => {
    // Given an app whose plan has no eligible service and its recorded relay.
    const harness = makeHarness();
    const recordPath = await writeAgentRelayWorker(harness, topologyApp, kind);
    try {
      // When only one ordinary service is rebuilt.
      await Effect.runPromise(
        rebuildApp(
          { services: [topologyWeb.name] },
          { plan: topologyPlan, root: topologyPlan.root, app: topologyApp },
        ).pipe(Effect.provide(harness.layer)),
      );
      // Then the relay unselected services may still use is retained.
      expect(await Bun.file(recordPath).exists()).toBe(true);
    } finally {
      await removeHarness(harness);
    }
  });
}

test("a whole-app start keeps the SSH agent relay a needed service still uses", async () => {
  // Given a plan with an SSH agent service and its recorded relay.
  const harness = makeHarness();
  const recordPath = await writeAgentRelayWorker(harness, topologyApp, "ssh");
  const plan = {
    ...topologyPlan,
    extensions: { "@lando/core/ssh-agent": { mode: "sidecar" as const } },
    services: {
      [topologyWeb.name]: {
        ...topologyWeb,
        extensions: { "@lando/core/ssh-agent": { mode: "sidecar" as const } },
      },
    },
  };
  const session: AgentRelaySession = {
    appId: plan.id,
    sessionId: "ssh-session",
    kind: "ssh",
    socketName: "agent.sock",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/ssh-socket") },
    closed: Promise.resolve(),
    close: async () => undefined,
  };
  const sshSession = spyOn(sshAgentModule, "startSshAgentSession").mockImplementation(() =>
    Effect.succeed(session),
  );
  try {
    // When the whole app starts.
    await Effect.runPromise(
      startApp(
        {},
        {
          plan,
          root: plan.root,
          app: topologyApp,
          landofile: literalTestLandofile({
            name: plan.name,
            services: {},
            sshAgent: { sidecar: true },
          }),
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then the relay is acquired and retained for the eligible service.
    expect(sshSession.mock.calls).toHaveLength(1);
    expect(await Bun.file(recordPath).exists()).toBe(true);
  } finally {
    sshSession.mockRestore();
    await removeHarness(harness);
  }
});

test("a whole-app start keeps the GPG agent relay a needed service still uses", async () => {
  // Given a plan with a forwarding GPG agent service and its recorded relay.
  const harness = makeHarness();
  const recordPath = await writeAgentRelayWorker(harness, topologyApp, "gpg");
  const plan = {
    ...topologyPlan,
    extensions: { "@lando/core/gpg-agent": { forward: true } },
    services: {
      [topologyWeb.name]: {
        ...topologyWeb,
        extensions: { "@lando/core/gpg-agent": { forward: true } },
      },
    },
  };
  const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
  const session: AgentRelaySession = {
    appId: plan.id,
    sessionId: "gpg-session",
    kind: "gpg",
    socketName: "S.gpg-agent",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/gpg-socket") },
    closed: Promise.resolve(),
    close: async () => undefined,
  };
  const gpgSession = spyOn(gpgAgentModule, "startGpgAgentSession").mockImplementation(() =>
    Effect.succeed({ session, keyringDir: "/relay/gpg-keyring" }),
  );
  try {
    // When the whole app starts.
    await Effect.runPromise(
      startApp(
        {},
        {
          plan,
          root: plan.root,
          app: topologyApp,
          landofile: literalTestLandofile({
            name: plan.name,
            services: {},
            gpgAgent: { forward: true },
          }),
        },
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          select: () =>
            Effect.succeed({
              ...provider,
              capabilities: { ...provider.capabilities, agentSocket: { delivery: "bind-directory" } },
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    // Then the relay is retained for the forwarding service.
    expect(await Bun.file(recordPath).exists()).toBe(true);
  } finally {
    gpgSession.mockRestore();
    await removeHarness(harness);
  }
});
