/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 */
import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import { FileSystem, GlobalAppService, PathsService, SshService } from "@lando/sdk/services";

const SSH_SIDECAR_ID = "sidecar" as const;
const SSH_GLOBAL_SERVICE_NAME = "ssh-agent" as const;

const setupError = (cause: unknown): SshError =>
  new SshError({
    message: "SSH agent sidecar setup failed.",
    sshId: SSH_SIDECAR_ID,
    cause,
  });

export const sshService = Layer.effect(
  SshService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const paths = yield* PathsService;
    const fileSystem = yield* FileSystem;

    return {
      id: SSH_SIDECAR_ID,
      setup: (_options) =>
        Effect.gen(function* () {
          // Create the SSH sockets directory BEFORE starting the sidecar
          // (the bind mount needs this directory to exist)
          const sshDir = `${paths.roots.userDataRoot}/ssh`;
          const exists = yield* fileSystem.exists(sshDir);
          if (!exists) {
            yield* fileSystem.mkdir(sshDir);
          }

          // Now start the SSH agent sidecar global service
          yield* globalApp.ensureRunning([SSH_GLOBAL_SERVICE_NAME]);
        }).pipe(Effect.mapError(setupError)),
      getAgentSocket: (appId) =>
        Effect.succeed({
          // The socket is created by ssh-agent running in the sidecar
          // and exposed via the mounted volume
          socketPath: `${paths.roots.userDataRoot}/ssh/ssh-agent.sock`,
          appId,
        }),
    };
  }),
);
