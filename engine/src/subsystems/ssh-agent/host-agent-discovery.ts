import { lstat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { SshAgentUnavailableError } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { probeSshAgent } from "./agent-probe.ts";
import type { AgentRelayUpstream } from "./relay.ts";

export type HostSshAgentUpstream = AgentRelayUpstream & {
  readonly source: "explicit" | "env" | "1password" | "gpg" | "yubikey-agent" | "windows-openssh";
};
export type HostAgentPathKind = "missing" | "socket" | "symlink" | "other";
export interface DiscoveredHostSshAgent {
  readonly upstream: HostSshAgentUpstream;
  readonly identities: number;
}
export interface HostAgentDiscoveryOptions {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly explicitSocket?: string;
  /** Presence override for tests. Real discovery lstats when this is omitted. */
  readonly exists?: (path: string) => Promise<boolean>;
  readonly runGpgconf?: () => Promise<string | undefined>;
  readonly inspect?: (path: string) => Effect.Effect<HostAgentPathKind, never>;
  readonly probe?: (upstream: AgentRelayUpstream) => Effect.Effect<{ readonly identities: number }, unknown>;
  readonly gpgSocket?: Effect.Effect<string | undefined, never>;
  readonly probeTimeoutMs?: number;
  readonly gpgTimeoutMs?: number;
}

const unavailable = (reason: "socket-missing" | "host-agent-not-found", socketPath?: string) =>
  new SshAgentUnavailableError({
    message:
      reason === "socket-missing"
        ? "The configured SSH agent socket is unavailable."
        : "No host SSH agent was found.",
    mode: "host",
    reason,
    ...(socketPath === undefined ? {} : { socketPath }),
    remediation: "Start your SSH agent and set sshAgent.socket or SSH_AUTH_SOCK to its socket path.",
  });

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const nodeInspect = (path: string): Effect.Effect<HostAgentPathKind, never> =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause: unknown) => cause,
  }).pipe(
    Effect.map((stats): HostAgentPathKind => {
      if (stats.isSymbolicLink()) return "symlink";
      if (stats.isSocket()) return "socket";
      return "other";
    }),
    Effect.catchAll((cause) => {
      const kind: HostAgentPathKind = isEnoent(cause) ? "missing" : "other";
      return Effect.succeed(kind);
    }),
  );

const existsInspect =
  (exists: (path: string) => Promise<boolean>) =>
  (path: string): Effect.Effect<HostAgentPathKind, never> =>
    Effect.tryPromise({
      try: () => exists(path),
      catch: () => false,
    }).pipe(
      Effect.catchAll(() => Effect.succeed(false)),
      Effect.map((present): HostAgentPathKind => (present ? "socket" : "missing")),
    );

const nonempty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const readGpgSocket = (options: HostAgentDiscoveryOptions): Effect.Effect<string | undefined, never> => {
  if (options.gpgSocket !== undefined) return options.gpgSocket;
  const runGpgconf = options.runGpgconf;
  if (runGpgconf !== undefined) {
    return Effect.promise(async () => {
      try {
        return nonempty(await runGpgconf());
      } catch (cause) {
        if (cause instanceof Error) return undefined;
        throw cause;
      }
    });
  }
  return Effect.gen(function* () {
    const runner = yield* Effect.serviceOption(ProcessRunner);
    if (Option.isNone(runner)) return undefined;
    const result = yield* runner.value
      .run({
        cmd: "gpgconf",
        args: ["--list-dirs", "agent-ssh-socket"],
        timeoutMs: options.gpgTimeoutMs ?? 5_000,
      })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (result === undefined || result.exitCode !== 0) return undefined;
    return nonempty(result.stdout);
  });
};

const onePasswordPath = (options: HostAgentDiscoveryOptions): string | undefined => {
  const join = options.platform === "win32" ? win32.join : posix.join;
  switch (options.platform) {
    case "darwin":
      return join(options.home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");
    case "linux":
    case "wsl":
      return join(options.home, ".1password/agent.sock");
    default:
      return undefined;
  }
};

export const discoverHostSshAgent = (
  options: HostAgentDiscoveryOptions,
): Effect.Effect<DiscoveredHostSshAgent, SshAgentUnavailableError> =>
  Effect.gen(function* () {
    const inspect =
      options.inspect ?? (options.exists === undefined ? nodeInspect : existsInspect(options.exists));
    const probe = (upstream: AgentRelayUpstream) =>
      options.probe === undefined
        ? Effect.tryPromise({
            try: () => probeSshAgent(upstream, { timeoutMs: options.probeTimeoutMs ?? 2_000 }),
            catch: (cause: unknown) => cause,
          })
        : options.probe(upstream);
    const tryCandidate = (
      path: string,
      source: HostSshAgentUpstream["source"],
      authoritative: boolean,
    ): Effect.Effect<DiscoveredHostSshAgent | undefined, SshAgentUnavailableError> =>
      Effect.gen(function* () {
        const namedPipe = options.platform === "win32" && path.startsWith("\\\\.\\pipe\\");
        const upstream: HostSshAgentUpstream = {
          _tag: namedPipe ? "named-pipe" : "unix",
          path,
          source,
        };
        if (!namedPipe) {
          const kind = yield* inspect(path);
          if (authoritative && kind !== "socket")
            return yield* Effect.fail(unavailable("socket-missing", path));
          if (!authoritative && kind === "missing") return undefined;
        }
        const probed = yield* probe(upstream).pipe(Effect.either);
        if (probed._tag === "Right") return { upstream, identities: probed.right.identities };
        if (authoritative) return yield* Effect.fail(unavailable("socket-missing", path));
        return undefined;
      });
    const explicit = options.explicitSocket;
    if (explicit !== undefined) {
      const found = yield* tryCandidate(explicit, "explicit", true);
      if (found === undefined) return yield* Effect.fail(unavailable("socket-missing", explicit));
      return found;
    }
    const envSocket = nonempty(options.env.SSH_AUTH_SOCK);
    if (envSocket !== undefined) {
      const found = yield* tryCandidate(envSocket, "env", false);
      if (found !== undefined) return found;
    }
    const password = onePasswordPath(options);
    if (password !== undefined) {
      const found = yield* tryCandidate(password, "1password", false);
      if (found !== undefined) return found;
    }
    const gpg = yield* readGpgSocket(options);
    if (gpg !== undefined) {
      const found = yield* tryCandidate(gpg, "gpg", false);
      if (found !== undefined) return found;
    }
    const runtimeDir = nonempty(options.env.XDG_RUNTIME_DIR);
    if (runtimeDir !== undefined) {
      const join = options.platform === "win32" ? win32.join : posix.join;
      const found = yield* tryCandidate(
        join(runtimeDir, "yubikey-agent", "yubikey-agent.sock"),
        "yubikey-agent",
        false,
      );
      if (found !== undefined) return found;
    }
    if (options.platform === "win32") {
      const found = yield* tryCandidate(String.raw`\\.\pipe\openssh-ssh-agent`, "windows-openssh", false);
      if (found !== undefined) return found;
    }
    return yield* Effect.fail(unavailable("host-agent-not-found"));
  });
