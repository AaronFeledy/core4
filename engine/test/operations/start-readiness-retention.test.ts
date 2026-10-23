import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import {
  GpgAgentTransportError,
  ProviderUnavailableError,
  ProxyApplyError,
  ServiceNotReadyError,
  ServiceStartError,
} from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  ProcessRunner,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestFileSyncEngine, TestRouterService } from "@lando/sdk/test";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import * as composition from "../../src/composition.ts";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import * as readiness from "../../src/operations/service-readiness.ts";
import { startApp } from "../../src/operations/start.ts";
import * as gpgDiscovery from "../../src/subsystems/gpg-agent/discovery.ts";
import type { HostProxyRunLandoSession } from "../../src/subsystems/host-proxy/transport.ts";
import * as worker from "../../src/subsystems/host-proxy/worker.ts";
import * as relayWorker from "../../src/subsystems/ssh-agent/detached-worker.ts";
import * as sshDiscovery from "../../src/subsystems/ssh-agent/host-agent-discovery.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import { stubContainerHelper } from "../../src/testing/container-helper.ts";
import { failureOf } from "../subsystems/healthcheck/support.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

const routedPlan: AppPlan = {
  ...plan,
  routes: [
    {
      hostname: "web.test-start.lndo.site",
      priority: 2,
      scheme: "https",
      service: web.name,
      endpoint: 3000,
      backend: { service: web.name, protocol: "http", port: 3000 },
    },
  ],
};

const phases = ["apply", "dependency-gate", "app-build", "routes", "gpg-home", "readiness"] as const;
for (const phase of phases) {
  for (const outcome of ["failure", "interrupt"] as const) {
    test(`${phase} ${outcome} retains every established start resource and the primary cause`, async () => {
      const scope = await Effect.runPromise(Scope.make());
      const entered = Deferred.makeUnsafe<void>();
      const cleanup: string[] = [];
      const app = { kind: "user", id: acceleratedPlan.id, root: acceleratedPlan.root } as const;
      const extensions = {
        "@lando/core/ssh-agent": { mode: "host" },
        "@lando/core/gpg-agent": { forward: true },
        "@lando/core/service-features": { featureIds: ["lando.host-proxy"] },
      };
      const planned = {
        ...acceleratedPlan,
        routes: routedPlan.routes,
        extensions,
        services: Object.fromEntries(
          Object.entries(acceleratedPlan.services).map(([name, service]) => [
            name,
            { ...service, extensions },
          ]),
        ),
      };
      const remediation =
        phase === "gpg-home"
          ? "Install gpg in the service image, ensure the service user can write GNUPGHOME, and retry start."
          : `Repair ${phase} and retry start.`;
      const providerError = new ProviderUnavailableError({
        providerId: "lando",
        operation: "apply",
        message: phase,
        remediation,
      });
      const errors = {
        apply: providerError,
        "dependency-gate": new ServiceStartError({
          service: String(web.name),
          providerId: "lando",
          operation: "apply",
          message: phase,
          remediation,
        }),
        "app-build": providerError,
        routes: new ProxyApplyError({ proxyId: "traefik", app: String(app.id), message: phase, remediation }),
        "gpg-home": new GpgAgentTransportError({
          stage: "worker",
          message: `Unable to prepare the GPG home for service ${web.name}.`,
          remediation,
        }),
        readiness: new ServiceNotReadyError({
          app: planned.name,
          service: String(web.name),
          providerId: "lando",
          reason: "not-running",
          message: phase,
          remediation,
        }),
      };
      const primary = errors[phase];
      const gate = <E>(error: E) =>
        outcome === "failure"
          ? Effect.fail(error)
          : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const harness = makeHarness({
        plannedApp: planned,
        onDestroy: () => {
          cleanup.push("destroy");
        },
        onRemoveRoutes: () => {
          cleanup.push("remove-routes");
        },
        apply: () =>
          phase === "apply"
            ? gate(errors.apply)
            : phase === "dependency-gate"
              ? gate(errors["dependency-gate"])
              : Effect.succeed({ changed: true }),
        fileSync: {
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.succeed(true),
          sessionsPersistAcrossProcesses: true,
          createSession: () => Effect.succeed(FileSyncSessionRef.make("retained")),
          listSessions: () => Effect.succeed([]),
          flushSession: () => Effect.void,
          terminateSession: () =>
            Effect.sync(() => {
              cleanup.push("terminate");
            }),
          pauseSession: () =>
            Effect.sync(() => {
              cleanup.push("pause");
            }),
          appLifecycle: {
            drain: () =>
              Effect.sync(() => {
                cleanup.push("drain");
              }),
            invalidateDrain: () => Effect.void,
            dispose: () => Effect.void,
            completeDisposal: () => Effect.void,
            disposalPhase: () => Effect.succeed("active"),
          },
        },
      });
      const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const session = (kind: "ssh" | "gpg"): AgentRelaySession => ({
        appId: app.id,
        sessionId: `${kind}-session`,
        kind,
        socketName: kind === "ssh" ? "agent.sock" : "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make(`/relay/${kind}`) },
        closed: Promise.resolve(),
        close: async () => {
          cleanup.push(kind);
        },
      });
      const relayStart = spyOn(relayWorker, "startDetachedAgentRelayWorker").mockImplementation((options) => {
        const relay = session(options.kind);
        return (options.publish?.(relay) ?? Effect.void).pipe(Effect.as(relay));
      });
      const sshSource = spyOn(sshDiscovery, "discoverHostSshAgent").mockReturnValue(
        Effect.succeed({ upstream: { _tag: "unix", path: "/ssh.sock", source: "explicit" }, identities: 0 }),
      );
      const gpgSource = spyOn(gpgDiscovery, "discoverHostGpgAgent").mockReturnValue(
        Effect.succeed({ _tag: "unix", path: "/gpg.sock", source: "explicit" }),
      );
      const shim = spyOn(composition, "resolveContainerHelper").mockReturnValue(
        Effect.succeed(stubContainerHelper("/shim")),
      );
      const hostStart = spyOn(worker, "startDetachedHostProxyWorker").mockImplementation((options) => {
        const session: HostProxyRunLandoSession = {
          appId: app.id,
          sessionId: "host-session",
          token: "token",
          controlToken: "control",
          socketPath: "/proxy.sock",
          shimPath: "/shim",
          transport: "unix-socket",
          closed: Promise.resolve(),
          close: async () => {
            cleanup.push("host-proxy");
          },
        };
        return (options.publish?.(session) ?? Effect.void).pipe(Effect.as(session));
      });
      const barrier = spyOn(readiness, "waitForServiceReadiness").mockImplementation(() =>
        phase === "readiness" ? gate(errors.readiness) : Effect.succeed([]),
      );
      try {
        const operation = startApp(
          {},
          {
            plan: planned,
            root: planned.root,
            app,
            landofile: {
              name: planned.name,
              services: {},
              sshAgent: { sidecar: false },
              gpgAgent: { forward: true },
            },
          },
          { scope },
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...provider,
                capabilities: { ...provider.capabilities, agentSocket: { delivery: "bind-directory" } },
                exec: () =>
                  phase === "gpg-home" && outcome === "interrupt"
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.succeed({ exitCode: phase === "gpg-home" ? 1 : 0, stdout: "", stderr: "" }),
              }),
          }),
          Effect.provideService(BuildOrchestrator, {
            build: (plan) => Effect.succeed(plan),
            buildApp: () => (phase === "app-build" ? gate(errors["app-build"]) : Effect.void),
          }),
          Effect.provideService(ProcessRunner, {
            run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
            stream: () => Stream.empty,
            streamWithExit: () => Stream.make({ exitCode: 0 }),
          }),
          Effect.provideService(RouterService, {
            ...TestRouterService,
            applyRoutes: (routes, app) =>
              phase === "routes" ? gate(errors.routes) : TestRouterService.applyRoutes(routes, app),
            removeRoutes: () =>
              Effect.sync(() => {
                cleanup.push("remove-routes");
              }),
          }),
          Effect.provide(harness.layer),
        );
        const fiber = Effect.runFork(operation);
        if (outcome === "interrupt") {
          await Effect.runPromise(Deferred.await(entered));
          await Effect.runPromise(Fiber.interrupt(fiber));
        }
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          if (outcome === "interrupt") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          else {
            expect(Cause.findErrorOption(exit.cause)).toMatchObject({
              value: { _tag: primary._tag, remediation },
            });
            const projected = failureOutcomeFromCause(exit.cause);
            if (phase === "gpg-home")
              expect(projected.error).toMatchObject({ _tag: primary._tag, remediation });
            else expect(projected.error).toBe(primary);
            expect(projected.additionalErrors).toEqual([]);
          }
        }
        expect(byTag(harness.events, "post-app-start")).toEqual([]);
        expect(cleanup).toEqual([]);
        const journal = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
        expect(journal.pending?.phase).toBe(
          phase === "apply" || phase === "dependency-gate" ? "apply-intent" : "completed",
        );
        expect(journal.pending?.sessions).toMatchObject([{ name: "web/app-mount" }]);
        await Effect.runPromise(Scope.close(scope, Exit.void));
        expect(cleanup.sort()).toEqual(["gpg", "host-proxy", "ssh"]);
      } finally {
        relayStart.mockRestore();
        sshSource.mockRestore();
        gpgSource.mockRestore();
        shim.mockRestore();
        hostStart.mockRestore();
        barrier.mockRestore();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await rm(harness.userDataRoot, { recursive: true, force: true });
      }
    });
  }
}

test.each(["restart", "rebuild"] as const)(
  "full %s does not remove routes or tear down after readiness failure",
  async (operation) => {
    let applied = false;
    let cleanupAfterApply = 0;
    const harness = makeHarness({
      plannedApp: routedPlan,
      onApply: () => {
        applied = true;
      },
      onDestroy: () => {
        if (applied) cleanupAfterApply++;
      },
      onRemoveRoutes: () => {
        if (applied) cleanupAfterApply++;
      },
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: applied ? "stopped" : "running",
          state: applied ? "stopped" : "running",
          containerId: "container",
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
          exitCode: 17,
        }),
    });
    const target = {
      plan: routedPlan,
      root: plan.root,
      app: { kind: "user", id: plan.id, root: plan.root } as const,
    };
    const effect = operation === "restart" ? restartApp({}, target) : rebuildApp({}, target);
    const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(harness.layer)));
    expect(failureOf(exit)).toMatchObject({ _tag: "ServiceNotReadyError", service: String(web.name) });
    expect(cleanupAfterApply).toBe(0);
  },
);
