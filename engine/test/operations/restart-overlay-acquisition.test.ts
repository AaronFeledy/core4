import { expect, spyOn, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { BuildOrchestrator, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import * as composition from "../../src/composition.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { type PublishSession, withRetainedSession } from "../../src/operations/retained-session.ts";
import * as Gpg from "../../src/operations/start-gpg-agent.ts";
import * as Ssh from "../../src/operations/start-ssh-agent.ts";
import type { HostProxyRunLandoSession } from "../../src/subsystems/host-proxy/transport.ts";
import * as worker from "../../src/subsystems/host-proxy/worker.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import { stubContainerHelper } from "../../src/testing/container-helper.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const outcome of ["success", "failure", "interrupted"] as const) {
  test(`full restart acquires after stop and retains published agents through ${outcome}`, async () => {
    // Given surviving app ownership distinct from invocation lifetime.
    const calls: string[] = [];
    const closed: string[] = [];
    const owner = await Effect.runPromise(Scope.make());
    const entered = Deferred.makeUnsafe<void>();
    const desired: AppPlan = {
      ...plan,
      extensions: { "@lando/core/ssh-agent": { mode: "host" }, "@lando/core/gpg-agent": { forward: true } },
      services: {
        [web.name]: {
          ...web,
          extensions: {
            "@lando/core/ssh-agent": { mode: "host" },
            "@lando/core/gpg-agent": { forward: true },
            "@lando/core/service-features": { featureIds: ["lando.host-proxy"] },
          },
        },
      },
    };
    const target = {
      plan: desired,
      root: desired.root,
      app: { kind: "user" as const, id: desired.id, root: desired.root },
      landofile: literalTestLandofile({
        name: desired.name,
        services: {},
        sshAgent: { sidecar: false },
        gpgAgent: { forward: true },
      }),
    };
    const session = (kind: "ssh" | "gpg"): AgentRelaySession => ({
      appId: desired.id,
      sessionId: `restart-${kind}`,
      kind,
      socketName: kind === "ssh" ? "agent.sock" : "S.gpg-agent",
      mount: { _tag: "volume", volume: `${kind}-retained` },
      closed: Promise.resolve(),
      close: async () => {
        closed.push(kind);
      },
    });
    const acquire = (kind: "ssh" | "gpg") =>
      withRetainedSession(
        (publish: PublishSession<AgentRelaySession>) =>
          Effect.sync(() => {
            calls.push(`acquire:${kind}`);
            return session(kind);
          }).pipe(Effect.tap(publish)),
        Effect.succeed,
        { scope: owner, close: (value) => Effect.promise(() => value.close()) },
      );
    const ssh = spyOn(Ssh, "startSshAgentSession").mockImplementation(() => acquire("ssh"));
    const gpg = spyOn(Gpg, "startGpgAgentSession").mockImplementation(() =>
      acquire("gpg").pipe(Effect.map((value) => ({ session: value, keyringDir: "/keyring" }))),
    );
    const proxySession: HostProxyRunLandoSession = {
      appId: desired.id,
      sessionId: "restart-proxy",
      token: "token",
      controlToken: "control",
      socketPath: "/relay/proxy.sock",
      shimPath: "/relay/shim",
      transport: "unix-socket",
      closed: Promise.resolve(),
      close: async () => {
        closed.push("host-proxy");
      },
    };
    const helper = spyOn(composition, "resolveContainerHelper").mockReturnValue(
      Effect.succeed(stubContainerHelper("/shim")),
    );
    const proxy = spyOn(worker, "startDetachedHostProxyWorker").mockImplementation((options) =>
      Effect.gen(function* () {
        calls.push("acquire:host-proxy");
        expect(options.plan).toEqual(desired);
        expect(options.reusePolicy).toBe("exact");
        yield* options.publish?.(proxySession) ?? Effect.void;
        return proxySession;
      }),
    );
    const harness = makeHarness({
      plannedApp: desired,
      onDestroy: () => {
        calls.push("stop");
      },
      onApply: () =>
        Effect.gen(function* () {
          calls.push("apply");
          switch (outcome) {
            case "success":
              return;
            case "failure":
              return yield* Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "apply",
                  message: "Injected apply failure",
                  remediation: "Retry.",
                }),
              );
            case "interrupted":
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            default:
              return outcome satisfies never;
          }
        }),
      exec: () =>
        Effect.sync(() => {
          calls.push("gpg-prepare");
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    });
    try {
      const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const builder = await Effect.runPromise(BuildOrchestrator.pipe(Effect.provide(harness.layer)));
      // When a full restart completes, fails, or loses its invoking fiber.
      const fiber = Effect.runFork(
        restartApp({}, target, {
          scope: owner,
          onStopped: Effect.sync(() => {
            calls.push("stopped-cleanup");
          }),
        }).pipe(
          Effect.provideService(BuildOrchestrator, {
            ...builder,
            build: (value) =>
              Effect.sync(() => {
                calls.push("build");
                return value;
              }),
          }),
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...provider,
                capabilities: { ...provider.capabilities, agentSocket: { delivery: "volume-relay" } },
              }),
          }),
          Effect.provide(harness.layer),
        ),
      );
      if (outcome === "interrupted") {
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      const exit = await Effect.runPromise(Fiber.await(fiber));
      // Then sessions survive the invocation, and preparation only follows successful apply.
      expect(Exit.isSuccess(exit)).toBe(outcome === "success");
      expect(calls).toEqual([
        "stop",
        "stopped-cleanup",
        "acquire:gpg",
        "acquire:ssh",
        "acquire:host-proxy",
        "build",
        "apply",
        ...(outcome === "success" ? ["gpg-prepare"] : []),
      ]);
      expect(closed).toEqual([]);
      await Effect.runPromise(Scope.close(owner, Exit.void));
      expect(closed.sort()).toEqual(["gpg", "host-proxy", "ssh"]);
    } finally {
      ssh.mockRestore();
      gpg.mockRestore();
      proxy.mockRestore();
      helper.mockRestore();
      await Effect.runPromise(Scope.close(owner, Exit.void));
    }
  });
}
