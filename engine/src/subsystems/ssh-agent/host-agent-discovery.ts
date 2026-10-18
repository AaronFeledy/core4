import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { SshAgentUnavailableError, isErrnoCode } from "@lando/sdk/errors";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { probeSshAgent } from "./agent-probe.ts";
import type { AgentRelayUpstream } from "./relay.ts";

export type HostSshAgentUpstream = AgentRelayUpstream & {
  readonly source: "explicit" | "env" | "1password" | "gpg" | "yubikey-agent" | "windows-openssh";
};
export type HostAgentPathKind = "missing" | "socket" | "symlink" | "other";
export interface HostAgentInspection {
  readonly kind: HostAgentPathKind;
  readonly uid?: number;
  readonly targetUid?: number;
  readonly dangling?: boolean;
  readonly targetKind?: "socket" | "other";
}
export interface DiscoveredHostSshAgent {
  readonly upstream: HostSshAgentUpstream;
  readonly identities: number;
  readonly danglingEnvSocket?: string;
}
export interface HostAgentDiscoveryOptions {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly explicitSocket?: string;
  /** Presence override for tests. Real discovery lstats when this is omitted. */
  readonly exists?: (path: string) => Promise<boolean>;
  readonly runGpgconf?: () => Promise<string | undefined>;
  readonly inspect?: (path: string) => Effect.Effect<HostAgentInspection, never>;
  readonly probe?: (upstream: AgentRelayUpstream) => Effect.Effect<{ readonly identities: number }, unknown>;
  readonly gpgSocket?: Effect.Effect<string | undefined, never>;
  readonly probeTimeoutMs?: number;
  readonly gpgTimeoutMs?: number;
}

type DiscoveryReason =
  | "socket-missing"
  | "socket-not-socket"
  | "socket-owner-mismatch"
  | "env-socket-dangling"
  | "host-agent-not-found";

const DEFAULT_REMEDIATION =
  "Start your SSH agent and set sshAgent.socket or SSH_AUTH_SOCK to its socket path.";
const ENV_DANGLING_REMEDIATION =
  "The shell's agent socket points at one that no longer exists (common after VS Code or SSH reconnects). Open a new terminal, then restart the app.";
const OWNER_MISMATCH_REMEDIATION = "Point sshAgent.socket at an SSH agent socket owned by your user.";
const NOT_SOCKET_REMEDIATION = "Set sshAgent.socket to an SSH agent socket path.";

const unavailable = (reason: DiscoveryReason, socketPath?: string, owner?: string) =>
  new SshAgentUnavailableError({
    message:
      reason === "socket-missing"
        ? "The configured SSH agent socket is unavailable."
        : reason === "socket-not-socket"
          ? "The configured SSH agent socket is not a socket."
          : reason === "socket-owner-mismatch"
            ? `The configured SSH agent socket is owned by ${owner ?? "another user"}, not the current user.`
            : reason === "env-socket-dangling"
              ? "The shell's SSH_AUTH_SOCK points at a socket that no longer exists."
              : "No host SSH agent was found.",
    mode: "host",
    reason,
    ...(socketPath === undefined ? {} : { socketPath }),
    remediation:
      reason === "env-socket-dangling"
        ? ENV_DANGLING_REMEDIATION
        : reason === "socket-owner-mismatch"
          ? OWNER_MISMATCH_REMEDIATION
          : reason === "socket-not-socket"
            ? NOT_SOCKET_REMEDIATION
            : DEFAULT_REMEDIATION,
  });

const socketOwnerLabel = (uid: number): string => `uid ${uid}`;

const explicitOwnerMismatch = (
  inspection: HostAgentInspection,
  path: string,
): SshAgentUnavailableError | undefined => {
  const self = process.getuid?.();
  if (self === undefined) return undefined;
  for (const uid of [inspection.uid, inspection.targetUid]) {
    if (uid !== undefined && uid !== self)
      return unavailable("socket-owner-mismatch", path, socketOwnerLabel(uid));
  }
  return undefined;
};

const isUsableSocket = (inspection: HostAgentInspection): boolean =>
  inspection.kind === "socket" || (inspection.kind === "symlink" && inspection.targetKind === "socket");

const nodeInspect = (path: string): Effect.Effect<HostAgentInspection, never> =>
  Effect.tryPromise({
    try: async (): Promise<HostAgentInspection> => {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        try {
          const target = await lstat(await realpath(path));
          return {
            kind: "symlink",
            uid: stats.uid,
            targetUid: target.uid,
            targetKind: target.isSocket() ? "socket" : "other",
          };
        } catch (cause: unknown) {
          if (isErrnoCode(cause, "ENOENT")) return { kind: "symlink", uid: stats.uid, dangling: true };
          return { kind: "symlink", uid: stats.uid, targetKind: "other" };
        }
      }
      if (stats.isSocket()) return { kind: "socket", uid: stats.uid };
      return { kind: "other", uid: stats.uid };
    },
    catch: (cause: unknown) => cause,
  }).pipe(
    Effect.catch((cause) => {
      const inspection: HostAgentInspection = isErrnoCode(cause, "ENOENT")
        ? { kind: "missing" }
        : { kind: "other" };
      return Effect.succeed(inspection);
    }),
  );

const existsInspect =
  (exists: (path: string) => Promise<boolean>) =>
  (path: string): Effect.Effect<HostAgentInspection, never> =>
    Effect.tryPromise({
      try: () => exists(path),
      catch: () => false,
    }).pipe(
      Effect.catch(() => Effect.succeed(false)),
      Effect.map((present): HostAgentInspection => (present ? { kind: "socket" } : { kind: "missing" })),
    );

const nonempty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const readGpgSocket = Effect.fnUntraced(function* (
  options: HostAgentDiscoveryOptions,
): Effect.fn.Return<string | undefined, never> {
  if (options.gpgSocket !== undefined) return yield* options.gpgSocket;
  const runGpgconf = options.runGpgconf;
  if (runGpgconf !== undefined) {
    return yield* Effect.promise(async () => {
      try {
        return nonempty(await runGpgconf());
      } catch (cause) {
        if (cause instanceof Error) return undefined;
        throw cause;
      }
    });
  }
  const runner = yield* Effect.serviceOption(ProcessRunner);
  if (Option.isNone(runner)) return undefined;
  const result = yield* runner.value
    .run({
      cmd: "gpgconf",
      args: ["--list-dirs", "agent-ssh-socket"],
      timeoutMs: options.gpgTimeoutMs ?? 5_000,
    })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (result === undefined || result.exitCode !== 0) return undefined;
  return nonempty(result.stdout);
});

const onePasswordPath = (options: HostAgentDiscoveryOptions): string | undefined => {
  switch (options.platform) {
    case "darwin":
      return posix.join(options.home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");
    case "linux":
    case "wsl":
      return posix.join(options.home, ".1password/agent.sock");
    default:
      return undefined;
  }
};

export const hostSshAgentSourceLabel = (source: HostSshAgentUpstream["source"]): string => {
  switch (source) {
    case "1password":
      return "1Password";
    case "gpg":
      return "gpg-agent";
    case "yubikey-agent":
      return "yubikey-agent";
    case "windows-openssh":
      return "Windows OpenSSH";
    case "env":
      return "SSH_AUTH_SOCK";
    case "explicit":
      return "sshAgent.socket";
    default:
      return source satisfies never;
  }
};

export const discoverHostSshAgent = Effect.fnUntraced(function* (
  options: HostAgentDiscoveryOptions,
): Effect.fn.Return<DiscoveredHostSshAgent, SshAgentUnavailableError> {
  const inspect =
    options.inspect ?? (options.exists === undefined ? nodeInspect : existsInspect(options.exists));
  const probe = (upstream: AgentRelayUpstream) =>
    options.probe === undefined
      ? Effect.tryPromise({
          try: () => probeSshAgent(upstream, { timeoutMs: options.probeTimeoutMs ?? 2_000 }),
          catch: (cause: unknown) => cause,
        })
      : options.probe(upstream);
  let danglingEnvSocket: string | undefined;
  const withDangling = (found: DiscoveredHostSshAgent): DiscoveredHostSshAgent =>
    danglingEnvSocket === undefined ? found : { ...found, danglingEnvSocket };
  const tryCandidate = Effect.fnUntraced(function* (
    path: string,
    source: HostSshAgentUpstream["source"],
    authoritative: boolean,
  ): Effect.fn.Return<DiscoveredHostSshAgent | undefined, SshAgentUnavailableError> {
    const namedPipe = options.platform === "win32" && path.startsWith("\\\\.\\pipe\\");
    const upstream: HostSshAgentUpstream = {
      _tag: namedPipe ? "named-pipe" : "unix",
      path,
      source,
    };
    if (!namedPipe) {
      const inspection = yield* inspect(path);
      if (authoritative) {
        if (inspection.kind === "missing" || inspection.dangling === true) {
          return yield* Effect.fail(unavailable("socket-missing", path));
        }
        if (!isUsableSocket(inspection)) return yield* Effect.fail(unavailable("socket-not-socket", path));
        const mismatch = explicitOwnerMismatch(inspection, path);
        if (mismatch !== undefined) return yield* Effect.fail(mismatch);
      } else {
        if (inspection.kind === "missing") return undefined;
        if (inspection.dangling === true) {
          if (source === "env") danglingEnvSocket = path;
          return undefined;
        }
      }
    }
    const probed = yield* probe(upstream).pipe(Effect.result);
    if (probed._tag === "Success") return { upstream, identities: probed.success.identities };
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
    if (found !== undefined) return withDangling(found);
  }
  const password = onePasswordPath(options);
  if (password !== undefined) {
    const found = yield* tryCandidate(password, "1password", false);
    if (found !== undefined) return withDangling(found);
  }
  const gpg = yield* readGpgSocket(options);
  if (gpg !== undefined) {
    const found = yield* tryCandidate(gpg, "gpg", false);
    if (found !== undefined) return withDangling(found);
  }
  const runtimeDir = nonempty(options.env.XDG_RUNTIME_DIR);
  if (runtimeDir !== undefined) {
    const join = options.platform === "win32" ? win32.join : posix.join;
    const found = yield* tryCandidate(
      join(runtimeDir, "yubikey-agent", "yubikey-agent.sock"),
      "yubikey-agent",
      false,
    );
    if (found !== undefined) return withDangling(found);
  }
  if (options.platform === "win32") {
    const found = yield* tryCandidate(String.raw`\\.\pipe\openssh-ssh-agent`, "windows-openssh", false);
    if (found !== undefined) return withDangling(found);
  }
  return yield* Effect.fail(
    danglingEnvSocket === undefined
      ? unavailable("host-agent-not-found")
      : unavailable("env-socket-dangling", danglingEnvSocket),
  );
});
