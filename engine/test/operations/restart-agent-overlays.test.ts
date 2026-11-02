import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import {
  bringUpRecreateReasons,
  inspectBindSources,
} from "@lando/container-runtime/podman/bring-up-recreate";
import { ServiceRestartWouldRecreateError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  PortNumber,
  ProviderId,
  SSH_AGENT_SOCKET_NAME,
} from "@lando/sdk/schema";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Result } from "effect";
import { restartApp } from "../../src/operations/restart.ts";
import { withGpgAgentOverlay } from "../../src/subsystems/gpg-agent/overlay.ts";
import { stripGpgAgentOverlay } from "../../src/subsystems/gpg-agent/overlay.ts";
import { hostKnownHostsFile } from "../../src/subsystems/ssh-agent/host-known-hosts.ts";
import { stripSshAgentOverlay, withSshAgentOverlay } from "../../src/subsystems/ssh-agent/overlay.ts";
import {
  readAgentRelayWorkerRecord,
  writeAgentRelayWorkerRecord,
} from "../../src/subsystems/ssh-agent/worker-state.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const runtimeBindSources = (applied: AppPlan) => {
  const sources = inspectBindSources({
    Mounts: Object.values(applied.services).flatMap((service) =>
      service.mounts.map((mount) => ({
        Type: mount.type,
        Source: mount.type === "bind" ? mount.source : undefined,
        Name: mount.type === "volume" ? mount.store : undefined,
        Destination: mount.target,
      })),
    ),
  });
  if (sources === undefined) throw new TypeError("Expected inspect mount sources from the overlay fixture");
  return sources;
};

for (const kind of ["ssh", "gpg"] as const) {
  for (const drift of [false, true]) {
    test(`${kind} selected restart ${drift ? "refuses genuine source drift" : "retains unchanged forwarding"}`, async () => {
      // Given runtime mounts from the shipped overlay, but a sanitized desired plan.
      const eligible: AppPlan = {
        ...plan,
        services: {
          [web.name]: {
            ...web,
            extensions: {
              [kind === "ssh" ? "@lando/core/ssh-agent" : "@lando/core/gpg-agent"]:
                kind === "ssh" ? { mode: "host" } : { forward: true },
            },
          },
        },
      };
      let applied: AppPlan = eligible;
      let labels: ReturnType<typeof commonContainerLabels> = {};
      let appliedCalls = 0;
      let stops = 0;
      const desired = stripGpgAgentOverlay(stripSshAgentOverlay(eligible));
      const harness = makeHarness({
        plannedApp: desired,
        inspect: (target) =>
          Effect.succeed({
            app: plan.id,
            service: target.service,
            providerId: plan.provider,
            status: "running",
            publications: { status: "unknown" },
            bindSources: runtimeBindSources(applied),
            labels,
          }),
        onStop: () => {
          stops += 1;
        },
        onApply: (selected) => {
          appliedCalls += 1;
          for (const service of Object.values(selected.services)) {
            const bindSources = runtimeBindSources(applied);
            expect(bringUpRecreateReasons(selected, service, { bindSources, labels })).toEqual([]);
          }
        },
      });
      const app = { kind: "user" as const, id: plan.id, root: plan.root };
      const paths = await Effect.runPromise(PathsService.pipe(Effect.provide(harness.layer)));
      const privateFileAccess = await Effect.runPromise(
        PrivateFileAccessService.pipe(Effect.provide(harness.layer)),
      );
      const record = {
        appId: app.id,
        appRoot: app.root,
        sessionId: "retained",
        kind,
        protocolVersion: 2 as const,
        configDigest: "digest",
        pid: process.pid,
        controlToken: "unchanged",
        controlPort: PortNumber.make(12345),
        socketName: kind === "ssh" ? SSH_AGENT_SOCKET_NAME : GPG_AGENT_SOCKET_NAME,
        mount: {
          _tag: "bind-directory" as const,
          directory: AbsolutePath.make(join(harness.userDataRoot, drift ? "new-source" : "retained-source")),
        },
      };
      const workerOptions = { kind, paths: paths.roots, privateFileAccess };
      await Effect.runPromise(writeAgentRelayWorkerRecord(app, workerOptions, record));
      const runtimeSession = {
        ...record,
        mount: {
          ...record.mount,
          directory: AbsolutePath.make(join(harness.userDataRoot, "retained-source")),
        },
      };
      applied =
        kind === "ssh"
          ? await Effect.runPromise(
              Effect.gen(function* () {
                const knownHostsFile = yield* hostKnownHostsFile(homedir());
                return yield* withSshAgentOverlay(
                  eligible,
                  runtimeSession,
                  knownHostsFile === undefined
                    ? {}
                    : {
                        knownHostsFile: knownHostsFile.path,
                        knownHostsSourceIdentity: knownHostsFile.sourceIdentity,
                      },
                );
              }),
            )
          : Effect.runSync(
              withGpgAgentOverlay(
                eligible,
                runtimeSession,
                join(paths.agentRelayRunDir("gpg", plan.id, plan.root), "keyring"),
              ),
            );
      const originalService = applied.services[web.name];
      if (originalService === undefined) throw new TypeError("Expected original overlay service");
      labels = commonContainerLabels(applied, originalService);

      // When the selected service is restarted without replacing its relay.
      const exit = await Effect.runPromise(
        Effect.result(
          restartApp(
            { services: [web.name] },
            {
              plan: desired,
              root: plan.root,
              app,
            },
          ).pipe(Effect.provide(harness.layer)),
        ),
      );

      // Then unchanged forwarding passes both preflights; a changed source refuses before stop.
      Result.match(exit, {
        onFailure: (failure) => {
          expect(drift).toBe(true);
          expect(failure).toBeInstanceOf(ServiceRestartWouldRecreateError);
          expect(failure).toMatchObject({ reason: "bind-source" });
          expect(stops).toBe(0);
          expect(appliedCalls).toBe(0);
        },
        onSuccess: () => {
          expect(drift).toBe(false);
          expect(stops).toBe(1);
          expect(appliedCalls).toBe(1);
        },
      });
      expect(await Effect.runPromise(readAgentRelayWorkerRecord(app, workerOptions))).toEqual(record);
    });
  }
}

test.each(["lando", "docker", "podman"])(
  "retains the same-provider %s SSH sidecar volume without restarting its session",
  async (provider) => {
    const desired: AppPlan = {
      ...plan,
      provider: ProviderId.make(provider),
      extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } },
      services: { [web.name]: { ...web, extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } } } },
    };
    const knownHostsFile = await Effect.runPromise(hostKnownHostsFile(homedir()));
    const runtimePlan = Effect.runSync(
      withSshAgentOverlay(
        desired,
        {
          kind: "ssh",
          socketName: SSH_AGENT_SOCKET_NAME,
          mount: { _tag: "volume", volume: "retained-agent" },
        },
        knownHostsFile === undefined
          ? {}
          : {
              knownHostsFile: knownHostsFile.path,
              knownHostsSourceIdentity: knownHostsFile.sourceIdentity,
            },
      ),
    );
    const bindSources = runtimeBindSources(runtimePlan);
    const originalService = runtimePlan.services[web.name];
    if (originalService === undefined) throw new TypeError("Expected original sidecar service");
    const labels = commonContainerLabels(runtimePlan, originalService);
    let setupCalls = 0;
    let applyCalls = 0;
    const harness = makeHarness({
      plannedApp: desired,
      inspect: (target) =>
        Effect.succeed({
          app: plan.id,
          service: target.service,
          providerId: plan.provider,
          status: "running",
          publications: { status: "unknown" },
          bindSources,
          labels,
        }),
      onApply: (selected) => {
        applyCalls += 1;
        for (const service of Object.values(selected.services)) {
          expect(bringUpRecreateReasons(selected, service, { bindSources, labels })).toEqual([]);
        }
      },
    });
    const globalApp = await Effect.runPromise(GlobalAppService.pipe(Effect.provide(harness.layer)));
    await Effect.runPromise(
      restartApp(
        { services: [web.name] },
        {
          plan: desired,
          root: desired.root,
          app: { kind: "user", id: plan.id, root: plan.root },
        },
      ).pipe(
        Effect.provideService(GlobalAppService, {
          ...globalApp,
          providerId: Effect.succeed(desired.provider),
        }),
        Effect.provideService(SshService, {
          id: "retained",
          setup: () =>
            Effect.sync(() => {
              setupCalls += 1;
            }),
          getAgentSocket: (appId) =>
            Effect.succeed({ appId, socketPath: "/unused", runtimeVolume: "retained-agent" }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    expect(applyCalls).toBe(1);
    expect(setupCalls).toBe(0);
  },
);
