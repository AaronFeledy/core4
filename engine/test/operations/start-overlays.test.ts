import { expect, spyOn, test } from "bun:test";
import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { BuildOrchestrator, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import * as Gpg from "../../src/operations/start-gpg-agent.ts";
import * as Ssh from "../../src/operations/start-ssh-agent.ts";
import { startApp } from "../../src/operations/start.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const operation of ["start", "restart", "rebuild", "selected-rebuild"] as const) {
  for (const failure of [
    "ssh-capability",
    "gpg-capability",
    "ssh-collision",
    "gpg-collision",
    "host-proxy-collision",
  ] as const) {
    test(`${operation} rejects ${failure} before provider mutation or worker acquisition`, async () => {
      // Given a read-only failure that is knowable without opening a session.
      const calls: string[] = [];
      const gpg = failure.startsWith("gpg");
      const proxy = failure === "host-proxy-collision";
      const desired: AppPlan = {
        ...plan,
        extensions: {
          [gpg ? "@lando/core/gpg-agent" : "@lando/core/ssh-agent"]: gpg
            ? { forward: true }
            : { mode: "host" },
        },
        services: {
          [web.name]: {
            ...web,
            extensions: proxy
              ? { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } }
              : {
                  [gpg ? "@lando/core/gpg-agent" : "@lando/core/ssh-agent"]: gpg
                    ? { forward: true }
                    : { mode: "host" },
                },
            mounts: failure.endsWith("collision")
              ? [
                  {
                    type: "bind",
                    source: "/authored",
                    target: PortablePath.make(
                      proxy ? "/usr/local/bin/lando" : gpg ? "/run/lando/gpg-agent" : "/run/lando/ssh-agent",
                    ),
                    readOnly: true,
                    realization: "passthrough",
                    origin: "authored",
                  },
                ]
              : [],
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
          gpgAgent: { forward: gpg },
        }),
      };
      const harness = makeHarness({
        plannedApp: desired,
        onStop: () => {
          calls.push("stop");
        },
        onDestroy: () => {
          calls.push("destroy");
        },
        onApply: () => {
          calls.push("apply");
        },
        onBuildApp: () => {
          calls.push("build-app");
        },
      });
      const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const builder = await Effect.runPromise(BuildOrchestrator.pipe(Effect.provide(harness.layer)));
      const { agentSocket: _agentSocket, ...capabilities } = provider.capabilities;
      const ssh = spyOn(Ssh, "startSshAgentSession").mockImplementation(() =>
        Effect.sync(() => {
          calls.push("ssh-acquire");
          return undefined;
        }),
      );
      const gpgSession = spyOn(Gpg, "startGpgAgentSession").mockImplementation(() =>
        Effect.die("Unexpected GPG acquisition"),
      );
      try {
        const run =
          operation === "start"
            ? startApp({}, target)
            : operation === "restart"
              ? restartApp({}, target)
              : rebuildApp(operation === "selected-rebuild" ? { services: [web.name] } : {}, target);
        // When the real lifecycle operation is invoked.
        const result = await Effect.runPromise(
          run.pipe(
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
                  capabilities: {
                    ...capabilities,
                    ...(failure.endsWith("capability")
                      ? {}
                      : { agentSocket: { delivery: "bind-directory" as const } }),
                    hostReachability: "emulated",
                    hostProxy: { containerTargets: [{ os: "linux", arch: "x64" }] },
                  },
                }),
            }),
            Effect.provide(harness.layer),
            Effect.result,
          ),
        );
        // Then nothing destructive or session-owning has happened.
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: proxy
              ? "HostProxyTransportUnavailableError"
              : gpg
                ? failure.endsWith("capability")
                  ? "GpgAgentUnavailableError"
                  : "GpgAgentTransportError"
                : failure.endsWith("capability")
                  ? "SshAgentUnavailableError"
                  : "SshAgentTransportError",
          },
        });
        expect(calls).toEqual([]);
      } finally {
        ssh.mockRestore();
        gpgSession.mockRestore();
      }
    });
  }
}
