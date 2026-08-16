/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 *
 * The SSH agent sidecar is a global service that forwards SSH agent sockets
 * into app networks. Services opt in via `sshAgent: true` in their config.
 */
import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import type { AppId } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";

const SSH_SIDECAR_ID = "ssh-agent" as const;

const setupError = (cause: unknown): SshError =>
  new SshError({
    message: "SSH agent sidecar setup failed.",
    sshId: SSH_SIDECAR_ID,
    remediation: "Run `lando meta:global:start ssh-agent` and resolve the reported global-app failure.",
    cause,
  });

export const SshServiceLive = Layer.effect(
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
          yield* globalApp.ensureRunning([SSH_SIDECAR_ID]);

          // Create the SSH sockets directory if it doesn't exist
          const sshDir = `${paths.userDataRoot}/ssh`;
          const exists = yield* fileSystem.exists(sshDir);
          if (!exists) {
            yield* fileSystem.mkdir(sshDir);
          }
        }).pipe(Effect.mapError(setupError)),
      getAgentSocket: (appId) =>
        Effect.succeed({
          socketPath: `${paths.userDataRoot}/ssh/${String(appId)}.sock`,
          appId,
        }),
    };
  }),
);
