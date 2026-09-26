/**
 * Bridge authored `sshAgent.upstream` into the host CLI env that the ssh-agent
 * sidecar Effect reads at materialize time.
 *
 * Precedence: env overlay, then global config, then the cwd Landofile.
 */

import { isAbsoluteUnixSocketPath } from "@lando/sdk/schema";

export const LANDO_SSH_AGENT_UPSTREAM_ENV = "LANDO_SSH_AGENT_UPSTREAM" as const;
export const LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV = "LANDO_CONFIG__ssh_agent__upstream" as const;

export const SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE =
  "SSH agent upstream is not supported on Windows because it needs a Unix socket.";

export const SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION =
  "Unset sshAgent.upstream to keep the default sidecar file-load from ~/.ssh, or run Lando on macOS, Linux, or WSL.";

export const SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE =
  'sshAgent.upstream must be "host" or an absolute Unix socket path.';

export type AuthoredSshAgentUpstreamSources = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config?: { readonly upstream?: string | undefined } | undefined;
  readonly landofile?: { readonly upstream?: string | undefined } | undefined;
};

export const authoredSshAgentUpstreamFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const friendly = env[LANDO_SSH_AGENT_UPSTREAM_ENV]?.trim();
  if (friendly !== undefined && friendly.length > 0) return friendly;
  const overlay = env[LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV]?.trim();
  if (overlay !== undefined && overlay.length > 0) return overlay;
  return undefined;
};

const nonempty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

export const resolveAuthoredSshAgentUpstream = (input: AuthoredSshAgentUpstreamSources): string | undefined =>
  authoredSshAgentUpstreamFromEnv(input.env) ??
  nonempty(input.config?.upstream) ??
  nonempty(input.landofile?.upstream);

export const envWithSshAgentUpstream = (
  env: Readonly<Record<string, string | undefined>>,
  sshAgent: { readonly upstream?: string | undefined } | undefined,
): Record<string, string | undefined> => {
  const next = { ...env };
  if (sshAgent?.upstream !== undefined && authoredSshAgentUpstreamFromEnv(next) === undefined) {
    next[LANDO_SSH_AGENT_UPSTREAM_ENV] = sshAgent.upstream;
  }
  return next;
};

export const applySshAgentUpstreamToProcessEnv = (
  sshAgent: { readonly upstream?: string | undefined } | undefined,
  env: Record<string, string | undefined> = process.env,
): (() => void) => {
  if (sshAgent?.upstream === undefined || authoredSshAgentUpstreamFromEnv(env) !== undefined) {
    return () => undefined;
  }
  const previous = env[LANDO_SSH_AGENT_UPSTREAM_ENV];
  env[LANDO_SSH_AGENT_UPSTREAM_ENV] = sshAgent.upstream;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(env, LANDO_SSH_AGENT_UPSTREAM_ENV);
    else env[LANDO_SSH_AGENT_UPSTREAM_ENV] = previous;
  };
};

export const sshAgentUpstreamInstallRefusal = (
  authored: string | undefined,
  platform: string,
): { readonly message: string; readonly remediation: string } | undefined => {
  if (authored === undefined) return undefined;
  if (platform === "win32") {
    return {
      message: SSH_AGENT_UPSTREAM_WINDOWS_MESSAGE,
      remediation: SSH_AGENT_UPSTREAM_WINDOWS_REMEDIATION,
    };
  }
  if (authored !== "host" && !isAbsoluteUnixSocketPath(authored)) {
    return {
      message: SSH_AGENT_UPSTREAM_INVALID_PATH_MESSAGE,
      remediation: 'Set sshAgent.upstream to "host" or an absolute Unix socket path.',
    };
  }
  return undefined;
};
