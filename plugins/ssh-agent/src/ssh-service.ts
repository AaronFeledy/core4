/**
 * SSH Service Live implementation - manages SSH agent sidecar via global app.
 */
import { chmod, mkdir, stat } from "node:fs/promises";

import { DateTime, Effect, Layer } from "effect";

import { makeUserAppResolution } from "@lando/landofile/app-resolution";
import { SshError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { SshAgentConfig } from "@lando/sdk/schema";
import {
  ConfigService,
  EventService,
  GlobalAppService,
  LandofileService,
  PathsService,
  SshService,
} from "@lando/sdk/services";

import {
  type SshAgentUpstreamResolution,
  authoredUpstreamFromEnv,
  resolveSshAgentUpstream,
} from "./upstream.ts";

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

const windowsUpstreamError = (
  resolution: Extract<SshAgentUpstreamResolution, { kind: "unsupported" }>,
): SshError =>
  new SshError({
    message: `${resolution.message} ${resolution.remediation}`,
    sshId: SSH_SIDECAR_ID,
  });

const publishWarn = (body: string): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const events = yield* Effect.serviceOption(EventService);
    if (events._tag === "None") return;
    yield* events.value
      .publish(
        MessageWarnEvent.make({
          _tag: "message.warn",
          body,
          timestamp: DateTime.unsafeMake(new Date().toISOString()),
        }),
      )
      .pipe(Effect.catchAll(() => Effect.void));
  });

export type SshServiceHost = {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isSocket?: (path: string) => boolean;
};

const resolveAuthoredUpstream = (
  config: SshAgentConfig | undefined,
  landofile: SshAgentConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => authoredUpstreamFromEnv(env) ?? config?.upstream ?? landofile?.upstream;

const peekLandofileSshAgent = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(LandofileService);
  if (service._tag === "None") return undefined;
  const resolution = makeUserAppResolution({
    assertVersionConstraint: () => Effect.void,
  });
  const landofile = yield* resolution
    .loadUserLandofile(service.value)
    .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
  return landofile?.sshAgent;
});

export const makeSshService = (host: SshServiceHost = {}) =>
  Layer.effect(
    SshService,
    Effect.gen(function* () {
      const globalApp = yield* GlobalAppService;
      const paths = yield* PathsService;
      const platform = host.platform ?? process.platform;
      const env = host.env ?? process.env;

      return {
        id: SSH_SIDECAR_ID,
        setup: (_options) =>
          Effect.gen(function* () {
            const config = yield* Effect.serviceOption(ConfigService);
            const sshAgent =
              config._tag === "Some"
                ? yield* config.value.get("sshAgent").pipe(Effect.catchAll(() => Effect.succeed(undefined)))
                : undefined;
            const landofileSshAgent = yield* peekLandofileSshAgent;
            const resolution = resolveSshAgentUpstream({
              upstream: resolveAuthoredUpstream(sshAgent, landofileSshAgent, env),
              sshAuthSock: env.SSH_AUTH_SOCK,
              platform,
              ...(host.isSocket === undefined ? {} : { isSocket: host.isSocket }),
            });

            if (resolution.kind === "unsupported") {
              return yield* Effect.fail(windowsUpstreamError(resolution));
            }
            if (resolution.kind === "invalid") {
              return yield* Effect.fail(
                new SshError({
                  message: resolution.message,
                  sshId: SSH_SIDECAR_ID,
                }),
              );
            }
            if (resolution.kind === "fallback") {
              yield* publishWarn(resolution.warning);
            }

            const sshDir = `${paths.roots.userDataRoot}/ssh`;
            yield* Effect.tryPromise({
              try: () => ensurePrivateSshDirectory(sshDir),
              catch: (cause: unknown) => cause,
            });
            // ensureRunning rematerializes the global dist (globalInstall) then starts the sidecar.
            yield* globalApp.ensureRunning([SSH_GLOBAL_SERVICE_NAME]);
          }).pipe(Effect.mapError((cause) => (cause instanceof SshError ? cause : setupError(cause)))),
        getAgentSocket: (appId) =>
          Effect.succeed({
            socketPath: `${paths.roots.userDataRoot}/ssh/ssh-agent.sock`,
            appId,
          }),
      };
    }),
  );

export const sshService = makeSshService();
