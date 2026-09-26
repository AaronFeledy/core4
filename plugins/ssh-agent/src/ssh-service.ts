/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 */
import { chmod, mkdir, stat } from "node:fs/promises";
import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";

const SSH_SIDECAR_ID = "sidecar" as const;
const SSH_GLOBAL_SERVICE_NAME = "ssh-agent" as const;
const SSH_DIRECTORY_MODE = 0o700;

const setupError = (cause: unknown): SshError =>
  new SshError({
    message: "SSH agent sidecar setup failed.",
    sshId: SSH_SIDECAR_ID,
    cause,
  });

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

/** `<userDataRoot>/ssh` is private. A looser existing directory is tightened; a tighter one is left alone. */
export const ensurePrivateSshDirectory = async (sshDir: string): Promise<void> => {
  try {
    const current = await stat(sshDir);
    if ((current.mode & 0o077) !== 0) await chmod(sshDir, SSH_DIRECTORY_MODE);
  } catch (cause) {
    if (!isEnoent(cause)) throw cause;
    await mkdir(sshDir, { recursive: true, mode: SSH_DIRECTORY_MODE });
    await chmod(sshDir, SSH_DIRECTORY_MODE);
  }
};

export const sshService = Layer.effect(
  SshService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const paths = yield* PathsService;

    return {
      id: SSH_SIDECAR_ID,
      setup: (_options) =>
        Effect.gen(function* () {
          const sshDir = `${paths.roots.userDataRoot}/ssh`;
          yield* Effect.tryPromise({
            try: () => ensurePrivateSshDirectory(sshDir),
            catch: (cause: unknown) => cause,
          });
          yield* globalApp.ensureRunning([SSH_GLOBAL_SERVICE_NAME]);
        }).pipe(Effect.mapError(setupError)),
      getAgentSocket: (appId) =>
        Effect.succeed({
          socketPath: `${paths.roots.userDataRoot}/ssh/ssh-agent.sock`,
          appId,
        }),
    };
  }),
);
