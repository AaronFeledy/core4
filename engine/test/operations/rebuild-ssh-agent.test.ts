import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppPlan, PortablePath, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, SshService } from "@lando/sdk/services";
import { Effect, Exit, Scope } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import * as worker from "../../src/subsystems/ssh-agent/detached-worker.ts";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/ssh/intent.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test.each(["sidecar", "host"] as const)(
  "selected-service rebuild preserves the SSH overlay in %s mode",
  async (mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rebuild-agent-"));
    const socketPath = join(root, "upstream.sock");
    const server = createServer((socket) =>
      socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
    );
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const selected: AppPlan = {
      ...plan,
      root: AbsolutePath.make(root),
      extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode } },
      services: {
        [web.name]: { ...web, extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode } } },
        [ServiceName.make("other")]: { ...web, name: ServiceName.make("other"), primary: false },
      },
    };
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: selected,
      onApply: (value) => {
        applied.push(value);
      },
    });
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
    let closed = 0;
    const released = Promise.withResolvers<void>();
    const startWorker = spyOn(worker, "startDetachedAgentRelayWorker").mockImplementation(() =>
      Effect.succeed({
        appId: selected.id,
        sessionId: "rebuild-session",
        kind: "ssh",
        socketName: "agent.sock",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make(join(root, "relay")) },
        closed: released.promise,
        close: async () => {
          closed += 1;
          released.resolve();
        },
      }),
    );
    try {
      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void),
            );
            return yield* rebuildApp(
              { services: [web.name] },
              {
                plan: selected,
                root: selected.root,
                app: { kind: "user", id: selected.id, root: selected.root },
                landofile: {
                  name: selected.name,
                  services: {},
                  sshAgent: { sidecar: mode === "sidecar", socket: socketPath },
                },
              },
              { scope },
            );
          }),
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...provider,
                capabilities: { ...provider.capabilities, agentSocket: { delivery: "bind-directory" } },
              }),
          }),
          Effect.provideService(SshService, {
            id: "sidecar",
            setup: () => Effect.void,
            getAgentSocket: (appId) => Effect.succeed({ appId, socketPath }),
          }),
          Effect.provide(harness.layer),
        ),
      );
      // Then
      expect(applied).toHaveLength(1);
      expect(Object.keys(applied[0]?.services ?? {})).toEqual(["web"]);
      expect(applied[0]?.services[web.name]?.environment.SSH_AUTH_SOCK).toBe(
        "/run/lando/ssh-agent/agent.sock",
      );
      expect(applied[0]?.services[web.name]?.mounts).toContainEqual({
        type: "bind",
        source: AbsolutePath.make(join(root, "relay")),
        target: PortablePath.make("/run/lando/ssh-agent"),
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
      });
      expect(closed).toBe(1);
    } finally {
      startWorker.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each(["sidecar", "host"] as const)(
  "selected-service rebuild honors %s failure policy without agent delivery",
  async (mode) => {
    // Given
    const selected: AppPlan = {
      ...plan,
      extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode } },
      services: { [web.name]: { ...web, extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode } } } },
    };
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: selected,
      onApply: (value) => {
        applied.push(value);
      },
    });
    try {
      // When
      const result = await Effect.runPromise(
        rebuildApp(
          { services: [web.name] },
          {
            plan: selected,
            root: selected.root,
            app: { kind: "user", id: selected.id, root: selected.root },
            landofile: { name: selected.name, services: {}, sshAgent: { sidecar: mode === "sidecar" } },
          },
        ).pipe(Effect.either, Effect.provide(harness.layer)),
      );
      // Then
      if (mode === "host") {
        expect(result).toMatchObject({
          _tag: "Left",
          left: { _tag: "SshAgentUnavailableError", reason: "capability-missing" },
        });
        expect(applied).toEqual([]);
      } else {
        expect(result._tag).toBe("Right");
        expect(applied).toHaveLength(1);
        expect(applied[0]?.services[web.name]?.environment.SSH_AUTH_SOCK).toBeUndefined();
        expect(applied[0]?.services[web.name]?.mounts).toEqual([]);
        expect(harness.events.filter((event) => event._tag === "message.warn")).toHaveLength(1);
      }
    } finally {
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
