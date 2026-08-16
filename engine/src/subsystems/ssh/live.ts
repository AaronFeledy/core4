/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 *
 * The SSH agent sidecar is a global service that forwards SSH agent sockets
 * into app networks. Services opt in via `sshAgent: true` in their config.
 */
import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import type { AppId } from "@lando/sdk/schema";
import { type FileSystem, GlobalAppService, PathsService, SshService } from "@lando/sdk/services";

const SSH_SIDECAR_ID = "ssh-agent" as const;

const setupError = (cause: unknown): SshError =>
  new SshError({
    message: "SSH agent sidecar setup failed.",
    sshId: SSH_SIDECAR_ID,
    remediation:
      "Run `lando meta:global:start ssh-agent` and resolve the reported global-app failure.",
    cause,
  });

const agentError = (app: AppId, cause: unknown): SshError =>
  new SshError({
    message: `SSH agent socket retrieval failed for ${String(app)}.`,
    sshId: SSH_SIDECAR_ID,
    remediation: "Ensure the SSH agent sidecar is running via `lando setup`, then retry.",
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
      setup: (options) =>
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
        Effect.gen(function* () {
          // Return the socket path for this app's SSH agent
          // The actual socket will be created by the SSH agent sidecar global service
          const socketPath = `${paths.userDataRoot}/ssh/${String(appId)}.sock`;
          return {
            socketPath,
            appId,
          };
        }).pipe(Effect.mapError((cause) => agentError(appId, cause))),
    };
  }),
);
