/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 */
import { chmod, mkdir, stat } from "node:fs/promises";
import { Effect, Layer } from "effect";

import { SshError, isErrnoCode } from "@lando/sdk/errors";
import { GlobalAppService, PathsService, SshService } from "@lando/sdk/services";
import { SSH_AGENT_VOLUME } from "./socket.ts";

const SSH_SIDECAR_ID = "sidecar" as const;
const SSH_GLOBAL_SERVICE_NAME = "ssh-agent" as const;
const SSH_DIRECTORY_MODE = 0o700;

const setupError = (cause: unknown): SshError =>
  new SshError({
    message: "SSH agent sidecar setup failed.",
    sshId: SSH_SIDECAR_ID,
    cause,
  });

/** `<userDataRoot>/ssh` is private. A looser existing directory is tightened; a tighter one is left alone. */
export const ensurePrivateSshDirectory = async (sshDir: string): Promise<void> => {
  try {
    const current = await stat(sshDir);
    if ((current.mode & 0o077) !== 0) await chmod(sshDir, SSH_DIRECTORY_MODE);
  } catch (cause) {
    if (!isErrnoCode(cause, "ENOENT")) throw cause;
    await mkdir(sshDir, { recursive: true, mode: SSH_DIRECTORY_MODE });
    await chmod(sshDir, SSH_DIRECTORY_MODE);
  }
};

export const layer = Layer.effect(
  SshService,
  Effect.gen(function* () {
    const globalApp = yield* GlobalAppService;
    const paths = yield* PathsService;

    return SshService.of({
      id: SSH_SIDECAR_ID,
      setup: Effect.fn("SshService.setup")(function* (_options) {
        const sshDir = `${paths.roots.userDataRoot}/ssh`;
        yield* Effect.tryPromise({
          try: () => ensurePrivateSshDirectory(sshDir),
          catch: (cause: unknown) => cause,
        });
        yield* globalApp.ensureRunning([SSH_GLOBAL_SERVICE_NAME]);
      }, Effect.mapError(setupError)),
      getAgentSocket: Effect.fn("SshService.getAgentSocket")((appId) =>
        Effect.succeed({
          socketPath: `${paths.roots.userDataRoot}/ssh/ssh-agent.sock`,
          runtimeVolume: SSH_AGENT_VOLUME,
          appId,
        }),
      ),
    });
  }),
);
