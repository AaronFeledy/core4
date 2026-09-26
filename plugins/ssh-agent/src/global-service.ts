/**
 * SSH agent sidecar global service.
 *
 * Default mode runs a real ssh-agent and file-loads keys from ~/.ssh.
 * Opt-in upstream mode relays a host Unix agent socket into the sidecar.
 * Apps still talk only to the Lando socket from getAgentSocket.
 */
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";

import { ServiceConfig } from "@lando/sdk/schema";

import {
  type ResolveSshAgentUpstreamInput,
  type SshAgentUpstreamResolution,
  authoredUpstreamFromEnv,
  resolveSshAgentUpstream,
} from "./upstream.ts";

export const SSH_AUTH_SOCK_PATH = "/ssh-auth/ssh-agent.sock" as const;
export const SSH_UPSTREAM_SOCK_PATH = "/ssh-upstream/agent.sock" as const;

const fileLoadCommand = [
  "apk add --no-cache openssh-client",
  "mkdir -p /ssh-auth",
  "eval $(ssh-agent -s -a /ssh-auth/ssh-agent.sock)",
  "chmod 777 /ssh-auth/ssh-agent.sock",
  // Load host keys from ~/.ssh
  // ssh-add without args loads id_rsa, id_dsa, id_ecdsa, id_ed25519
  // Skip passphrase-protected keys gracefully (no stdin in container)
  "ssh-add 2>/dev/null || true",
  // Keep container running
  "tail -f /dev/null",
].join(" && ");

const upstreamCommand = [
  "apk add --no-cache openssh-client socat",
  "mkdir -p /ssh-auth",
  "socat UNIX-LISTEN:/ssh-auth/ssh-agent.sock,fork,mode=0777,unlink-early UNIX-CONNECT:/ssh-upstream/agent.sock",
].join(" && ");

const socketVolumeMount = {
  type: "bind" as const,
  source: join(makeLandoPaths().roots.userDataRoot, "ssh"),
  target: "/ssh-auth",
  readOnly: false,
};

const hostKeysMount = {
  type: "bind" as const,
  source: "~/.ssh",
  target: "/root/.ssh",
  readOnly: true,
};

const decodeConfig = (value: unknown): ServiceConfig => Schema.decodeUnknownSync(ServiceConfig)(value);

const sidecarService = (command: string, mounts: ReadonlyArray<typeof socketVolumeMount>) =>
  decodeConfig({
    api: 4,
    type: "compose",
    appMount: false,
    image: "alpine:3.20",
    // The sidecar keeps no per-user state, so there is no home to persist.
    home: false,
    command: ["sh", "-c", command],
    mounts,
    environment: {
      SSH_AUTH_SOCK: SSH_AUTH_SOCK_PATH,
    },
  });

export const buildFileLoadSshAgentServiceConfig = (): ServiceConfig =>
  sidecarService(fileLoadCommand, [socketVolumeMount, hostKeysMount]);

export const buildUpstreamSshAgentServiceConfig = (hostSocketPath: string): ServiceConfig =>
  sidecarService(upstreamCommand, [
    socketVolumeMount,
    {
      type: "bind",
      source: hostSocketPath,
      target: SSH_UPSTREAM_SOCK_PATH,
      readOnly: false,
    },
  ]);

export const sshAgentServiceConfigFor = (resolution: SshAgentUpstreamResolution): ServiceConfig => {
  if (resolution.kind === "unsupported" || resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  return resolution.kind === "upstream"
    ? buildUpstreamSshAgentServiceConfig(resolution.socketPath)
    : buildFileLoadSshAgentServiceConfig();
};

export const resolveHostSshAgentInput = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): ResolveSshAgentUpstreamInput => ({
  upstream: authoredUpstreamFromEnv(env),
  sshAuthSock: env.SSH_AUTH_SOCK,
  platform,
});

/**
 * Default export: an Effect that yields the SSH agent sidecar global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 * Unset upstream keeps file-load. Explicit upstream is resolved from the host CLI env.
 */
const sshAgentGlobalService: Effect.Effect<ServiceConfig> = Effect.sync(() =>
  sshAgentServiceConfigFor(resolveSshAgentUpstream(resolveHostSshAgentInput())),
);

export default sshAgentGlobalService;
