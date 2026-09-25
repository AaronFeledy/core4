import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppPlan, PortablePath } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, SshService } from "@lando/sdk/services";
import { Effect, Exit, Scope } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import * as gpgAgentModule from "../../src/operations/start-gpg-agent.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/gpg-agent/intent.ts";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../../src/subsystems/ssh/intent.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("selected-service rebuild composes the gpg overlay outside the ssh overlay", async () => {
  // Given
  const selected: AppPlan = {
    ...plan,
    extensions: {
      [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "sidecar" },
      [GPG_AGENT_PLAN_EXTENSION_KEY]: { forward: true },
    },
    services: {
      [web.name]: {
        ...web,
        extensions: {
          [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "sidecar" },
          [GPG_AGENT_PLAN_EXTENSION_KEY]: { forward: true },
        },
      },
    },
  };
  const root = await mkdtemp(join(tmpdir(), "rebuild-gpg-agent-"));
  const socketPath = join(root, "ssh-upstream.sock");
  const server = createServer((socket) =>
    socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const applied: AppPlan[] = [];
  const harness = makeHarness({ plannedApp: selected, onApply: (value) => applied.push(value) });
  const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
  let closed = 0;
  const gpgSession = spyOn(gpgAgentModule, "startGpgAgentSession").mockImplementation(() =>
    Effect.succeed({
      session: {
        appId: selected.id,
        sessionId: "gpg-rebuild-session",
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
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.acquireRelease(Scope.make(), (scopeHandle) =>
            Scope.close(scopeHandle, Exit.void),
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
                sshAgent: { sidecar: true },
                gpgAgent: { forward: true },
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
    expect(applied[0]?.services[web.name]?.environment.GNUPGHOME).toBe("/run/lando/gnupg");
    expect(applied[0]?.services[web.name]?.environment.SSH_AUTH_SOCK).toBe("/run/lando/ssh-agent/agent.sock");
    expect(applied[0]?.services[web.name]?.mounts).toContainEqual({
      type: "bind",
      source: "/relay/gpg-socket",
      target: PortablePath.make("/run/lando/gpg-agent"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    });
    expect(closed).toBe(1);
  } finally {
    gpgSession.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(harness.userDataRoot, { recursive: true, force: true });
  }
});
