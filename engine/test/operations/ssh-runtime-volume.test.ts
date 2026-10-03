import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { AppId, AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { EventService, PathsService, RuntimeProviderRegistry, SshService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import {
  resolveSshAgentUpstream,
  startSshAgentSession,
  withStartedSshAgent,
} from "../../src/operations/start-ssh-agent.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

const metadata = { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 };
const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "demo",
  name: "demo",
  slug: "demo",
  root: "/app/demo",
  provider: "lando",
  services: {
    web: {
      name: "web",
      type: "lando",
      provider: "lando",
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: { "@lando/core/ssh-agent": { mode: "sidecar" } },
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});
const app = { kind: "user" as const, id: "demo", root: plan.root };
const capabilities = { agentSocket: { delivery: "guest-bridge" as const } };
const ssh = {
  id: "sidecar",
  setup: () => Effect.void,
  getAgentSocket: (appId: AppId) =>
    Effect.succeed({ appId, socketPath: "/missing-host-agent.sock", runtimeVolume: "plugin-owned-agent" }),
};
const registry = (state: string, selected: string[]) => ({
  list: Effect.succeed([ProviderId.make("lando")]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: (selectedPlan?: AppPlan) => {
    selected.push(String(selectedPlan?.provider));
    return Effect.succeed({
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
    });
  },
});

test("managed sidecar uses the plugin volume without host probing or worker services", async () => {
  // Given
  const selected: string[] = [];
  // When
  const session = await Effect.runPromise(
    startSshAgentSession(plan, app, capabilities, { mode: "sidecar" }).pipe(
      Effect.provideService(SshService, ssh),
      Effect.provideService(RuntimeProviderRegistry, registry("running", selected)),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "darwin" })),
      Effect.provide(EventServiceLive),
      Effect.provide(PrivateFileAccessLive),
    ),
  );
  // Then
  expect(session?.mount).toEqual({ _tag: "volume", volume: "plugin-owned-agent" });
  expect(session?.socketName).toBe("agent.sock");
  expect(selected).toEqual(["lando"]);
  await session?.close();
});

test("stopped sidecar warns and leaves the app without an overlay", async () => {
  // Given
  const warnings: string[] = [];
  // When
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      const result = yield* withStartedSshAgent(
        plan,
        app,
        capabilities,
        { mode: "sidecar" },
        { use: Effect.succeed },
      );
      warnings.push(...(yield* events.query("message.warn")).map((event) => event.body));
      return result;
    }).pipe(
      Effect.provideService(SshService, ssh),
      Effect.provideService(RuntimeProviderRegistry, registry("exited", [])),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "linux" })),
      Effect.provide(EventServiceLive),
      Effect.provide(PrivateFileAccessLive),
    ),
  );
  // Then
  expect(warnings).toHaveLength(1);
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([]);
  expect(result.stores).toEqual([]);
});

test.each(["docker", "podman", "missing-volume"])("%s keeps the host socket probe path", async (provider) => {
  // Given
  const selected: string[] = [];
  const service =
    provider === "missing-volume"
      ? {
          ...ssh,
          getAgentSocket: (appId: AppId) => Effect.succeed({ appId, socketPath: "/missing-host-agent.sock" }),
        }
      : ssh;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      resolveSshAgentUpstream({
        appId: plan.id,
        provider: ProviderId.make(provider === "missing-volume" ? "lando" : provider),
        intent: { mode: "sidecar" },
      }),
    ).pipe(
      Effect.provideService(SshService, service),
      Effect.provideService(RuntimeProviderRegistry, registry("running", selected)),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "sidecar-not-running" } });
  expect(selected).toEqual([]);
});
