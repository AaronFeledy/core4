/**
 * Bridge global `sshAgent.upstream` into the host CLI env that the ssh-agent
 * sidecar Effect reads at materialize time. Env overlays already win.
 */

export const LANDO_SSH_AGENT_UPSTREAM_ENV = "LANDO_SSH_AGENT_UPSTREAM" as const;
export const LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV = "LANDO_CONFIG__ssh_agent__upstream" as const;

export const authoredSshAgentUpstreamFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const friendly = env[LANDO_SSH_AGENT_UPSTREAM_ENV]?.trim();
  if (friendly !== undefined && friendly.length > 0) return friendly;
  const overlay = env[LANDO_SSH_AGENT_UPSTREAM_OVERLAY_ENV]?.trim();
  if (overlay !== undefined && overlay.length > 0) return overlay;
  return undefined;
};

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
