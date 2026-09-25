import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, type AppPlan, ServiceName } from "@lando/sdk/schema";
import { PathsService, type RuntimeProviderShape } from "@lando/sdk/services";
import { PrivateFileAccessLive, type PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { withStartedGpgAgent } from "../../src/operations/start-gpg-agent.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import { app, plan } from "../subsystems/gpg-agent/fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E, PathsService | PrivateFileAccessService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(PathsService, makeLandoPaths()), Effect.provide(PrivateFileAccessLive)),
  );

const exec: RuntimeProviderShape["exec"] = () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });

test("gpg forwarding skips when forward is false", async () => {
  // Given
  // When
  const result = await run(
    withStartedGpgAgent(plan, app, {}, { forward: false }, { exec, use: Effect.succeed }),
  );
  // Then
  expect(result).toBe(plan);
});

test("gpg capability-missing fails before apply", async () => {
  // Given
  let applied = false;
  // When
  const result = await run(
    Effect.either(
      withStartedGpgAgent(
        plan,
        app,
        {},
        { forward: true },
        {
          exec,
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
    left: { _tag: "GpgAgentUnavailableError", reason: "capability-missing" },
  });
  expect(applied).toBe(false);
});

test("gpg overlays eligible services and closes the session on use failure", async () => {
  // Given
  let closed = false;
  const session: AgentRelaySession = {
    appId: plan.id,
    sessionId: "test",
    kind: "gpg",
    socketName: "S.gpg-agent",
    mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
    closed: Promise.resolve(),
    close: async () => {
      closed = true;
    },
  };
  // When
  await run(
    Effect.either(
      withStartedGpgAgent(
        plan,
        app,
        { agentSocket: { delivery: "bind-directory" } },
        { forward: true },
        {
          exec,
          startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
          use: (overlaid) => {
            expect(overlaid.services[ServiceName.make("db")]).toBe(plan.services[ServiceName.make("db")]);
            expect(overlaid.services[ServiceName.make("web")]?.environment.GNUPGHOME).toBe(
              "/run/lando/gnupg",
            );
            return Effect.fail("apply failed");
          },
        },
      ),
    ),
  );
  // Then
  expect(closed).toBe(true);
});

for (const exitCode of [0, 1]) {
  test(`gpg initializes each service after apply on every start and fails closed for exit ${exitCode}`, async () => {
    // Given
    const web = plan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("missing web fixture");
    const selected: AppPlan = {
      ...plan,
      services: {
        ...plan.services,
        [web.name]: { ...web, user: "1001:1001" },
        [ServiceName.make("worker")]: { ...web, name: ServiceName.make("worker"), user: "app" },
      },
    };
    const calls: string[] = [];
    let closed = 0;
    const session: AgentRelaySession = {
      appId: plan.id,
      sessionId: "same-session",
      kind: "gpg",
      socketName: "S.gpg-agent",
      mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
      closed: Promise.resolve(),
      close: async () => {
        closed += 1;
      },
    };
    const initialize: RuntimeProviderShape["exec"] = (target, command) =>
      Effect.sync(() => {
        calls.push(`${target.service}:${target.user}`);
        expect(target.app).toBe(plan.id);
        expect(command.command.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(command.command[2]).toContain("--import-ownertrust");
        expect(command.command[2]).toContain('"$GNUPGHOME/S.gpg-agent"');
        return { exitCode, stdout: "", stderr: "private diagnostic" };
      });
    const start = withStartedGpgAgent(
      selected,
      app,
      { agentSocket: { delivery: "bind-directory" } },
      { forward: true },
      {
        exec: initialize,
        startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
        use: () =>
          Effect.sync(() => {
            calls.push("apply");
          }),
      },
    );
    // When
    const results = await run(Effect.all([Effect.either(start), Effect.either(start)]));
    // Then
    if (exitCode === 0) {
      expect(calls).toEqual(["apply", "web:1001:1001", "worker:app", "apply", "web:1001:1001", "worker:app"]);
      expect(results.map((result) => result._tag)).toEqual(["Right", "Right"]);
      expect(closed).toBe(0);
    } else {
      expect(calls).toEqual(["apply", "web:1001:1001", "apply", "web:1001:1001"]);
      for (const result of results) {
        expect(result).toMatchObject({
          _tag: "Left",
          left: {
            _tag: "GpgAgentTransportError",
            stage: "worker",
            remediation: expect.stringMatching(/install.*gpg.*image/i),
          },
        });
        expect(JSON.stringify(result)).not.toContain("private diagnostic");
      }
      expect(closed).toBe(2);
    }
  });
}
