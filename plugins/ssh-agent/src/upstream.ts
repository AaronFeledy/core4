import { type SshAgentUpstream, isAbsoluteUnixSocketPath } from "@lando/sdk/schema";

import { hostPathIsUnixSocket } from "./unix-socket.ts";

export const LANDO_SSH_AGENT_UPSTREAM_ENV = "LANDO_SSH_AGENT_UPSTREAM" as const;
export const LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV = "LANDO_CONFIG__ssh_agent__upstream" as const;
export const HOST_SSH_AUTH_SOCK_ENV = "SSH_AUTH_SOCK" as const;

export const SSH_AGENT_UPSTREAM_FALLBACK_WARNING =
  "SSH agent upstream is set, but the host agent socket is missing or is not a Unix socket. Setup rematerializes the sidecar to file-load from ~/.ssh. Keys that live only in an SSH agent, hardware keys, agent-forwarded keys, and passphrase-protected keys that file ssh-add skips will not work. Start a host agent, set SSH_AUTH_SOCK, or point sshAgent.upstream at an absolute Unix socket path, then rerun `lando setup` or `lando global:install`.";

export const SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE =
  "SSH agent upstream is not supported on Windows because it needs a Unix socket.";

export const SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION =
  "Unset sshAgent.upstream to keep the default sidecar file-load from ~/.ssh, or run Lando on macOS, Linux, or WSL.";

export const SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE =
  'sshAgent.upstream must be "host" or an absolute Unix socket path.';

export type SshAgentUpstreamResolution =
  | { readonly kind: "file-load" }
  | { readonly kind: "upstream"; readonly socketPath: string; readonly requested: SshAgentUpstream }
  | {
      readonly kind: "fallback";
      readonly requested: SshAgentUpstream;
      readonly reason: "missing-sock";
      readonly warning: string;
    }
  | {
      readonly kind: "unsupported";
      readonly requested: SshAgentUpstream;
      readonly reason: "windows";
      readonly message: string;
      readonly remediation: string;
    }
  | { readonly kind: "invalid"; readonly requested: string; readonly message: string };

export type ResolveSshAgentUpstreamInput = {
  readonly upstream?: string | undefined;
  readonly sshAuthSock?: string | undefined;
  readonly platform: string;
  readonly isSocket?: (path: string) => boolean;
};

export const authoredUpstreamFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const friendly = env[LANDO_SSH_AGENT_UPSTREAM_ENV]?.trim();
  if (friendly !== undefined && friendly.length > 0) return friendly;
  const overlay = env[LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV]?.trim();
  if (overlay !== undefined && overlay.length > 0) return overlay;
  return undefined;
};

const parseAuthoredUpstream = (value: string): SshAgentUpstream | { readonly invalid: string } => {
  if (value === "host") return "host";
  if (isAbsoluteUnixSocketPath(value)) return value;
  return { invalid: value };
};

export const resolveSshAgentUpstream = (input: ResolveSshAgentUpstreamInput): SshAgentUpstreamResolution => {
  const authored = input.upstream?.trim();
  if (authored === undefined || authored.length === 0) return { kind: "file-load" };

  const parsed = parseAuthoredUpstream(authored);
  if (typeof parsed === "object") {
    return { kind: "invalid", requested: parsed.invalid, message: SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE };
  }

  if (input.platform === "win32") {
    return {
      kind: "unsupported",
      requested: parsed,
      reason: "windows",
      message: SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
      remediation: SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
    };
  }

  const socketPath = parsed === "host" ? input.sshAuthSock?.trim() : parsed;
  const isSocket = input.isSocket ?? hostPathIsUnixSocket;
  if (socketPath === undefined || socketPath.length === 0 || !isSocket(socketPath)) {
    return {
      kind: "fallback",
      requested: parsed,
      reason: "missing-sock",
      warning: SSH_AGENT_UPSTREAM_FALLBACK_WARNING,
    };
  }

  return { kind: "upstream", socketPath, requested: parsed };
};
