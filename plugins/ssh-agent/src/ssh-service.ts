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
    remediation: "Check the global app status and ensure the runtime provider is available.",
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
          // Ensure the SSH agent sidecar global service is running
          // This starts the real ssh-agent in the container
          yield* globalApp.ensureRunning([SSH_GLOBAL_SERVICE_NAME]);

          // Create the SSH sockets directory if it doesn't exist
          const sshDir = `${paths.userDataRoot}/ssh`;
          const exists = yield* fileSystem.exists(sshDir);
          if (!exists) {
            yield* fileSystem.mkdir(sshDir);
          }
        }).pipe(Effect.mapError(setupError)),
      getAgentSocket: (appId) =>
        Effect.succeed({
          // The socket is created by ssh-agent running in the sidecar
          // and exposed via the mounted volume
          socketPath: `${paths.userDataRoot}/ssh/ssh-agent.sock`,
          appId,
        }),
    };
  }),
);
