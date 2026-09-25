import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { EventService, PathsService, SshService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessLive } from "@lando/state-store/private-file-access";
import { DateTime, Effect } from "effect";
import * as operation from "../../src/operations/start-ssh-agent.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/app/demo") };
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: AppId.make(app.id),
  name: app.id,
  slug: app.id,
  root: app.root,
  provider: ProviderId.make("lando"),
  services: {
    [ServiceName.make("web")]: {
      name: ServiceName.make("web"),
      type: "lando",
      provider: ProviderId.make("lando"),
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
};
const capabilities = {
  ...TestRuntimeProvider.capabilities,
  agentSocket: { delivery: "bind-directory" as const },
};
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    EventService | PathsService | import("@lando/state-store/private-file-access").PrivateFileAccessService
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(EventServiceLive),
      Effect.provide(PrivateFileAccessLive),
      Effect.provideService(PathsService, makeLandoPaths({ platform: "linux" })),
    ),
  );

test("skips when no service carries lando.ssh-agent", async () => {
  // Given / When
  const result = await run(
    operation.withStartedSshAgent(
      { ...plan, services: {} },
      app,
      {},
      { mode: "host" },
      { use: Effect.succeed },
    ),
  );
  // Then
  expect(result.services).toEqual({});
});

test("global app plan is never overlaid", async () => {
  // Given / When
  const globalPlan = { ...plan, id: AppId.make("global") };
  const result = await run(
    operation.withStartedSshAgent(globalPlan, app, {}, { mode: "host" }, { use: Effect.succeed }),
  );
  // Then
  expect(result).toEqual(globalPlan);
});

test("fails SshAgentUnavailableError capability-missing before provider apply", async () => {
  // Given
  let applied = false;
  // When
  const result = await run(
    Effect.either(
      operation.withStartedSshAgent(
        plan,
        app,
        {},
        { mode: "host" },
        {
          use: () =>
            Effect.sync(() => {
              applied = true;
            }),
        },
      ),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "SshAgentUnavailableError", reason: "capability-missing" },
  });
  expect(applied).toBe(false);
});

for (const [label, caps, reason] of [
  ["a provider lacking agentSocket", {}, "capability-missing"],
  ["sidecar not running", capabilities, "sidecar-not-running"],
] as const) {
  test(`sidecar mode with ${label} starts without the overlay and warns`, async () => {
    // Given
    const warnings: string[] = [];
    // When
    const result = await run(
      Effect.gen(function* () {
        const events = yield* EventService;
        const result = yield* operation.withStartedSshAgent(
          plan,
          app,
          caps,
          { mode: "sidecar" },
          { use: Effect.succeed },
        );
        warnings.push(...(yield* events.query("message.warn")).map((event) => event.body));
        return result;
      }),
    );
    // Then
    expect(result.services[ServiceName.make("web")]?.mounts).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(reason);
  });
}

test("host mode with no agent fails host-agent-not-found and never spawns a worker", async () => {
  // Given / When
  const result = await run(
    Effect.either(
      operation.startSshAgentSession(
        plan,
        app,
        capabilities,
        { mode: "host" },
        {
          env: {},
          home: "/missing-host-agent-home",
          exists: async () => false,
          runGpgconf: async () => undefined,
        },
      ),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "host-agent-not-found" } });
});

test("sidecar mode uses SshService.getAgentSocket as upstream", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "agent-upstream-"));
  const socketPath = join(root, "agent.sock");
  const server = createServer((socket) =>
    socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const requested: string[] = [];
  try {
    // When
    const upstream = await Effect.runPromise(
      operation
        .resolveSshAgentUpstream({ appId: plan.id, intent: { mode: "sidecar" }, platform: "linux" })
        .pipe(
          Effect.provideService(SshService, {
            id: "sidecar",
            setup: () => Effect.void,
            getAgentSocket: (appId) => {
              requested.push(appId);
              return Effect.succeed({ appId, socketPath });
            },
          }),
        ),
    );
    // Then
    expect(upstream).toEqual({ _tag: "unix", path: socketPath });
    expect(requested).toEqual([plan.id]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of [false, true]) {
  test(`use ${failure ? "failure closes" : "success retains"} the session`, async () => {
    // Given
    let closed = 0;
    const session: AgentRelaySession = {
      appId: app.id,
      sessionId: "test",
      kind: "ssh",
      socketName: "agent.sock",
      mount: { _tag: "volume", volume: "agent" },
      close: async () => {
        closed++;
      },
      closed: Promise.resolve(),
    };
    // When
    await run(
      Effect.either(
        operation.withStartedSshAgent(
          plan,
          app,
          capabilities,
          { mode: "host" },
          {
            startSession: () => Effect.succeed(session),
            use: (overlaid) => (failure ? Effect.fail("apply") : Effect.succeed(overlaid)),
          },
        ),
      ),
    );
    // Then
    expect(closed).toBe(failure ? 1 : 0);
  });
}

test.each(["sidecar", "host"] as const)(
  "%s mode handles relay failure according to its failure policy",
  async (mode) => {
    // Given
    let applied = false;
    const error = new SshAgentTransportError({
      message: "Bridge failed",
      stage: "bridge",
      remediation: "Repair bridge",
    });
    // When
    const result = await run(
      Effect.either(
        operation.withStartedSshAgent(
          plan,
          app,
          capabilities,
          { mode },
          {
            startSession: () => Effect.fail(error),
            use: () =>
              Effect.sync(() => {
                applied = true;
              }),
          },
        ),
      ),
    );
    // Then
    expect(applied).toBe(mode === "sidecar");
    expect(result._tag).toBe(mode === "sidecar" ? "Right" : "Left");
  },
);
