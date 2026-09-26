import { Schema } from "effect";

/**
 * Absolute Unix-domain socket path. Rejects relative paths, Windows paths,
 * and named-pipe spellings so `sshAgent.upstream` cannot become mount soup.
 */
export const isAbsoluteUnixSocketPath = (value: string): boolean => {
  if (value.length < 2 || value.length > 4096) return false;
  if (!value.startsWith("/")) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  return true;
};

const AbsoluteUnixSocketPath = Schema.String.pipe(
  Schema.filter(isAbsoluteUnixSocketPath, {
    message: () => 'sshAgent.upstream must be "host" or an absolute Unix socket path.',
  }),
);

export const SshAgentUpstream = Schema.Union(Schema.Literal("host"), AbsoluteUnixSocketPath).annotations({
  identifier: "SshAgentUpstream",
  title: "SSH Agent Upstream",
  description:
    'Opt-in sidecar upstream: "host" uses the host CLI $SSH_AUTH_SOCK, or an absolute Unix socket path. Apps still use the Lando sidecar socket.',
});
export type SshAgentUpstream = typeof SshAgentUpstream.Type;
