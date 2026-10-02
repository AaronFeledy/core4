import { expect, test } from "bun:test";
import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { sshAgentPostureCheck } from "../../src/cli/commands/doctor-ssh-agent.ts";

test.each(["running", "exited"])(
  "doctor observes %s sidecar in the managed runtime without a host probe",
  async (state) => {
    // Given
    let probes = 0;
    const provider = {
      ...TestRuntimeProvider,
      id: ProviderId.make("lando"),
      inspect: () =>
        Effect.succeed({
          app: AppId.make("global"),
          service: ServiceName.make("ssh-agent"),
          providerId: ProviderId.make("lando"),
          status: state,
          state,
        }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    };
    // When
    const check = await Effect.runPromise(
      sshAgentPostureCheck({
        globalConfig: {},
        capabilities: { agentSocket: { delivery: "guest-bridge" } },
        sshService: {
          id: "sidecar",
          setup: () => Effect.void,
          getAgentSocket: (appId) =>
            Effect.succeed({ appId, socketPath: "/unreachable.sock", runtimeVolume: "lando-ssh-agent" }),
        },
        probe: async () => {
          probes++;
          return { identities: 0 };
        },
      }).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          list: Effect.succeed([provider.id]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
    );
    // Then
    expect(check.status).toBe(state === "running" ? "pass" : "warn");
    expect(check.details).toMatchObject({
      delivery: "runtime-volume",
      runtimeVolume: "lando-ssh-agent",
      upstream: { reachable: state === "running" },
    });
    expect(probes).toBe(0);
  },
);
