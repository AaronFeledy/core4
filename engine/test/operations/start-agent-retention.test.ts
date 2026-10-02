import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import type {
  GpgAgentTransportError,
  GpgAgentUnavailableError,
  SshAgentTransportError,
  SshAgentUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { type EventService, PathsService } from "@lando/sdk/services";
import { PrivateFileAccessLive, type PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { withStartedGpgAgent } from "../../src/operations/start-gpg-agent.ts";
import { withStartedSshAgent } from "../../src/operations/start-ssh-agent.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import type { AgentRelaySession } from "../../src/subsystems/ssh-agent/session.ts";
import { app, plan } from "../subsystems/gpg-agent/fixture.ts";

const selected = {
  ...plan,
  services: Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      {
        ...service,
        extensions: { ...service.extensions, "@lando/core/ssh-agent": { mode: "host" } },
      },
    ]),
  ),
};

for (const kind of ["ssh", "gpg"] as const) {
  for (const outcome of ["defect", "interrupted"] as const) {
    test(`${kind} closes exactly once on ${outcome} without transferring to the managed scope`, async () => {
      // Given
      const scope = await Effect.runPromise(Scope.make());
      const entered = Deferred.makeUnsafe<void>();
      const defect = new TypeError("apply defect");
      let closed = 0;
      const session: AgentRelaySession = {
        appId: selected.id,
        sessionId: "agent-session",
        kind,
        socketName: kind === "ssh" ? "agent.sock" : "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/socket") },
        closed: Promise.resolve(),
        close: async () => {
          closed++;
        },
      };
      const use = () => {
        switch (outcome) {
          case "defect":
            return Effect.die(defect);
          case "interrupted":
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          default:
            return outcome satisfies never;
        }
      };
      const operation: Effect.Effect<
        never,
        SshAgentTransportError | SshAgentUnavailableError | GpgAgentTransportError | GpgAgentUnavailableError,
        PathsService | PrivateFileAccessService | EventService
      > =
        kind === "ssh"
          ? withStartedSshAgent(
              selected,
              app,
              {},
              { mode: "host" },
              {
                managed: { scope },
                startSession: () => Effect.succeed(session),
                use,
              },
            )
          : withStartedGpgAgent(
              selected,
              app,
              {},
              { forward: true },
              {
                managed: { scope },
                startSession: () => Effect.succeed({ session, keyringDir: "/relay/keyring" }),
                exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
                use,
              },
            );
      // When
      const fiber = Effect.runFork(
        operation.pipe(
          Effect.provideService(PathsService, makeLandoPaths()),
          Effect.provide(PrivateFileAccessLive),
          Effect.provide(EventServiceLive),
        ),
      );
      if (outcome === "interrupted") {
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      const exit = await Effect.runPromise(Fiber.await(fiber));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      // Then
      expect(closed).toBe(1);
      switch (outcome) {
        case "defect":
          expect(exit).toEqual(Exit.die(defect));
          break;
        case "interrupted":
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          break;
        default:
          outcome satisfies never;
      }
    });
  }
}
