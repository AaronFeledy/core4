import { posix, win32 } from "node:path";
import { SshAgentUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { AgentRelayUpstream } from "./relay.ts";

export type HostSshAgentUpstream = AgentRelayUpstream & {
  readonly source: "explicit" | "env" | "1password" | "gpg" | "yubikey-agent" | "windows-openssh";
};
export interface HostAgentDiscoveryOptions {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly explicitSocket?: string;
  readonly exists: (path: string) => Promise<boolean>;
  readonly runGpgconf?: () => Promise<string | undefined>;
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

export const discoverHostSshAgent = (
  options: HostAgentDiscoveryOptions,
): Effect.Effect<HostSshAgentUpstream, SshAgentUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const candidate = (path: string, source: HostSshAgentUpstream["source"]): HostSshAgentUpstream => ({
        _tag: options.platform === "win32" && path.startsWith("\\\\.\\pipe\\") ? "named-pipe" : "unix",
        path,
        source,
      });
      const explicit = options.explicitSocket;
      if (explicit !== undefined) {
        if (!(await options.exists(explicit))) throw unavailable("socket-missing", explicit);
        return candidate(explicit, "explicit");
      }
      const envSocket = options.env.SSH_AUTH_SOCK;
      if (envSocket && (await options.exists(envSocket))) return candidate(envSocket, "env");
      const join = options.platform === "win32" ? win32.join : posix.join;
      const password =
        options.platform === "darwin"
          ? join(options.home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock")
          : options.platform === "linux"
            ? join(options.home, ".1password/agent.sock")
            : undefined;
      if (password !== undefined && (await options.exists(password))) return candidate(password, "1password");
      const gpg = (
        await options.runGpgconf?.().catch((cause: unknown) => {
          if (cause instanceof Error) return undefined;
          throw cause;
        })
      )?.trim();
      if (gpg && (await options.exists(gpg))) return candidate(gpg, "gpg");
      const runtimeDir = options.env.XDG_RUNTIME_DIR;
      if (runtimeDir) {
        const yubikey = join(runtimeDir, "yubikey-agent", "yubikey-agent.sock");
        if (await options.exists(yubikey)) return candidate(yubikey, "yubikey-agent");
      }
      if (options.platform === "win32")
        return candidate(String.raw`\\.\pipe\openssh-ssh-agent`, "windows-openssh");
      throw unavailable("host-agent-not-found");
    },
    catch: (cause) =>
      cause instanceof SshAgentUnavailableError ? cause : unavailable("host-agent-not-found"),
  });
