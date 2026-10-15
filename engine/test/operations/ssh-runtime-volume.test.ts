import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { SshError } from "@lando/sdk/errors";
import { AppId, AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, PathsService, RuntimeProviderRegistry, SshService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { resolveSshAgentUpstream, withStartedSshAgent } from "../../src/operations/start-ssh-agent.ts";
import * as LandoEventService from "../../src/services/event-service.ts";

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
  select: (selectedPlan?: AppPlan | ProviderId) => {
    selected.push(String(typeof selectedPlan === "string" ? selectedPlan : selectedPlan?.provider));
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

test.each(["win32", "linux", "darwin"] as const)(
  "managed sidecar on %s uses the plugin volume without host probing or worker services",
  async (platform) => {
    // Given
    const selected: string[] = [];
    let setups = 0;
    const warnings: string[] = [];
    // When
    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        const overlaid = yield* withStartedSshAgent(
          plan,
          app,
          capabilities,
          { mode: "sidecar" },
          { use: Effect.succeed },
        );
        warnings.push(...(yield* events.query("message.warn")).map((event) => event.body));
        return overlaid;
      }).pipe(
        Effect.provideService(SshService, {
          ...ssh,
          setup: () =>
            Effect.sync(() => {
              setups++;
            }),
        }),
        Effect.provideService(RuntimeProviderRegistry, registry("running", selected)),
        Effect.provideService(PathsService, makeLandoPaths({ platform })),
        Effect.provide(LandoEventService.layer),
        Effect.provide(PrivateFileAccessService.layer),
      ),
    );
    // Then
    expect(session.services[ServiceName.make("web")]?.environment.SSH_AUTH_SOCK).toBeDefined();
    expect(session.services[ServiceName.make("web")]?.mounts).toContainEqual(
      expect.objectContaining({ type: "volume", source: "plugin-owned-agent", readOnly: true }),
    );
    expect(setups).toBe(0);
    expect(selected).toEqual(["lando"]);
    expect(warnings).toEqual([]);
  },
);

test("stopped sidecar warns and leaves the app without an overlay", async () => {
  // Given
  const warnings: string[] = [];
  let setups = 0;
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
      Effect.provideService(SshService, {
        ...ssh,
        setup: () =>
          Effect.sync(() => {
            setups++;
          }),
      }),
      Effect.provideService(RuntimeProviderRegistry, registry("exited", [])),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "linux" })),
      Effect.provide(LandoEventService.layer),
      Effect.provide(PrivateFileAccessService.layer),
    ),
  );
  // Then
  expect(warnings).toHaveLength(1);
  expect(result.services[ServiceName.make("web")]?.mounts).toEqual([]);
  expect(result.stores).toEqual([]);
  expect(setups).toBe(1);
  expect(warnings[0]).toContain("The SSH agent sidecar stopped before its agent answered.");
  expect(warnings[0]).toContain("global:logs --service ssh-agent");
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
      Effect.provideService(SshService, {
        ...service,
        setup: () => Effect.fail(new SshError({ sshId: "sidecar", message: "offline" })),
      }),
      Effect.provideService(RuntimeProviderRegistry, registry("running", selected)),
      Effect.provide(LandoEventService.layer),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "sidecar-not-running" } });
  expect(selected).toEqual([]);
});

test("host-socket path stops waiting when the started sidecar exits", async () => {
  // Given
  let setups = 0;
  // When
  const result = await Effect.runPromise(
    Effect.result(
      resolveSshAgentUpstream({
        appId: plan.id,
        provider: ProviderId.make("docker"),
        intent: { mode: "sidecar" },
      }),
    ).pipe(
      Effect.provideService(SshService, {
        ...ssh,
        setup: () =>
          Effect.sync(() => {
            setups++;
          }),
      }),
      Effect.provideService(RuntimeProviderRegistry, registry("exited", [])),
      Effect.provide(LandoEventService.layer),
    ),
  );
  // Then
  expect(setups).toBe(1);
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: "sidecar-not-running",
      message: "The SSH agent sidecar stopped before its agent answered.",
    },
  });
});

test("stopped sidecar starts once and forwards after delayed readiness with task progress", async () => {
  // Given
  let setups = 0;
  let probes = 0;
  const providerRegistry = registry("running", []);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      // When
      const fiber = yield* Effect.forkChild(
        withStartedSshAgent(plan, app, capabilities, { mode: "sidecar" }, { use: Effect.succeed }),
      );
      yield* TestClock.adjust("2 seconds");
      const overlaid = yield* Fiber.join(fiber);
      return {
        overlaid,
        warnings: yield* events.query("message.warn"),
        trees: yield* events.query("task.tree.start"),
      };
    }).pipe(
      Effect.provideService(SshService, {
        ...ssh,
        setup: () =>
          Effect.sync(() => {
            setups++;
          }),
      }),
      Effect.provideService(RuntimeProviderRegistry, {
        ...providerRegistry,
        select: (input) =>
          providerRegistry.select(input).pipe(
            Effect.map((provider) => ({
              ...provider,
              inspect: () =>
                provider
                  .inspect()
                  .pipe(
                    Effect.map((service) => ({ ...service, state: setups === 0 ? "exited" : "running" })),
                  ),
              exec: () => Effect.sync(() => ({ exitCode: ++probes < 3 ? 2 : 0, stdout: "", stderr: "" })),
            })),
          ),
      }),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "linux" })),
      Effect.provide(PrivateFileAccessService.layer),
      Effect.provide(LandoEventService.layer),
      Effect.provide(TestClock.layer()),
    ),
  );
  // Then
  expect(setups).toBe(1);
  expect(result.overlaid.services[ServiceName.make("web")]?.environment.SSH_AUTH_SOCK).toBeDefined();
  expect(result.warnings).toEqual([]);
  expect(result.trees).toContainEqual(expect.objectContaining({ parentId: "start-ssh-sidecar-demo" }));
});

test.each([
  "SSH agent sidecar could not start: registry denied super-secret",
  "Registry denied super-secret",
])("setup failure preserves the redacted cause: %s", async (message) => {
  // Given
  const redactor = createRedactor("secrets", { values: ["super-secret"] });
  // When
  const warnings = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* withStartedSshAgent(plan, app, capabilities, { mode: "sidecar" }, { use: Effect.succeed });
      return (yield* events.query("message.warn")).map((event) => event.body);
    }).pipe(
      Effect.provideService(SshService, {
        ...ssh,
        setup: () =>
          Effect.fail(
            new SshError({
              sshId: "sidecar",
              message,
            }),
          ),
      }),
      Effect.provideService(RuntimeProviderRegistry, registry("exited", [])),
      Effect.provideService(RedactionService, {
        registerValues: () => Effect.void,
        forProfile: () => Effect.succeed(redactor),
      }),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "linux" })),
      Effect.provide(PrivateFileAccessService.layer),
      Effect.provide(LandoEventService.layer),
    ),
  );
  // Then
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("sidecar-not-running");
  expect(warnings[0]).toContain(`starting without it. ${redactor.redactString(message)}.`);
  expect(warnings[0]).toContain("lando restart");
  expect(warnings[0]).not.toContain("lando setup");
  expect(warnings[0]).not.toContain("super-secret");
});
