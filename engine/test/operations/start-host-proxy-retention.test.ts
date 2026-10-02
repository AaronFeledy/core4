import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import * as composition from "../../src/composition.ts";
import { withStartedHostProxy } from "../../src/operations/start-host-proxy.ts";
import type { HostProxyRunLandoSession } from "../../src/subsystems/host-proxy/transport.ts";
import * as worker from "../../src/subsystems/host-proxy/worker.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const selected = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
    },
  },
};
const app = { kind: "user" as const, id: selected.id, root: selected.root };

for (const lifetime of ["detached", "managed", "failure", "interrupted"] as const) {
  test(`host-proxy preserves its overlay and ${lifetime} lifetime`, async () => {
    // Given
    const harness = makeHarness();
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
    const scope = await Effect.runPromise(Scope.make());
    const entered = Deferred.makeUnsafe<void>();
    let closed = 0;
    const session: HostProxyRunLandoSession = {
      appId: selected.id,
      sessionId: "proxy-session",
      token: "token",
      controlToken: "control-token",
      socketPath: "/relay/proxy.sock",
      shimPath: "/relay/shim",
      transport: "unix-socket",
      closed: Promise.resolve(),
      close: async () => {
        closed++;
      },
    };
    const prepare = spyOn(composition, "prepareHostProxyShimArtifact").mockReturnValue(
      Effect.succeed("/shim"),
    );
    const spawn = spyOn(worker, "startDetachedHostProxyWorker").mockReturnValue(Effect.succeed(session));
    let socket: string | undefined;
    try {
      // When
      const operation = withStartedHostProxy(selected, app, provider.capabilities, {
        ...(lifetime === "detached" ? {} : { managed: { scope } }),
        use: (overlaid) =>
          Effect.gen(function* () {
            socket = overlaid.services[web.name]?.environment.LANDO_HOST_PROXY_SOCKET;
            switch (lifetime) {
              case "failure":
                return yield* Effect.fail("apply failed");
              case "interrupted":
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              case "detached":
              case "managed":
                return overlaid;
              default:
                return lifetime satisfies never;
            }
          }),
      }).pipe(Effect.provide(harness.layer));
      const fiber = Effect.runFork(operation);
      if (lifetime === "interrupted") {
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      const exit = await Effect.runPromise(Fiber.await(fiber));
      const closedBeforeScope = closed;
      await Effect.runPromise(Scope.close(scope, Exit.void));
      // Then
      expect(socket).toBe("/run/lando/host-proxy.sock");
      expect(closedBeforeScope).toBe(lifetime === "failure" || lifetime === "interrupted" ? 1 : 0);
      expect(closed).toBe(lifetime === "detached" ? 0 : 1);
      switch (lifetime) {
        case "failure":
          expect(exit).toEqual(Exit.fail("apply failed"));
          break;
        case "interrupted":
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          break;
        case "detached":
        case "managed":
          expect(Exit.isSuccess(exit)).toBe(true);
          break;
        default:
          lifetime satisfies never;
      }
    } finally {
      prepare.mockRestore();
      spawn.mockRestore();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}

for (const eventTag of ["task.complete", "task.tree.complete"] as const) {
  test(`closes the unreturned host-proxy worker when ${eventTag} defects`, async () => {
    // Given
    const defect = new TypeError("progress completion defect");
    const harness = makeHarness({
      onPublish: (event) => (event._tag === eventTag ? Effect.die(defect) : Effect.void),
    });
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
    let closed = 0;
    let applied = false;
    const prepare = spyOn(composition, "prepareHostProxyShimArtifact").mockReturnValue(
      Effect.succeed("/shim"),
    );
    const spawn = spyOn(worker, "startDetachedHostProxyWorker").mockReturnValue(
      Effect.succeed({
        appId: selected.id,
        sessionId: "proxy-session",
        token: "token",
        controlToken: "control-token",
        socketPath: "/relay/proxy.sock",
        shimPath: "/relay/shim",
        transport: "unix-socket",
        closed: Promise.resolve(),
        close: async () => {
          closed++;
        },
      }),
    );
    try {
      // When
      const exit = await Effect.runPromiseExit(
        withStartedHostProxy(selected, app, provider.capabilities, {
          use: () =>
            Effect.sync(() => {
              applied = true;
            }),
        }).pipe(Effect.provide(harness.layer)),
      );
      // Then
      expect(exit).toEqual(Exit.die(defect));
      expect(applied).toBe(false);
      expect(closed).toBe(1);
    } finally {
      prepare.mockRestore();
      spawn.mockRestore();
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  });
}
