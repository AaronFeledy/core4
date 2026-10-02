/**
 * SSH agent sidecar global service.
 *
 * Loads default host key files and publishes the agent inside the managed runtime.
 */
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";

import { ServiceConfig } from "@lando/sdk/schema";
import { SSH_AGENT_DIRECTORY, SSH_AGENT_SOCKET, SSH_AGENT_VOLUME } from "./socket.ts";

const sshAgentServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  appMount: false,
  image: "alpine:3.20",
  // The sidecar keeps no per-user state, so there is no home to persist.
  home: false,
  command: [
    "sh",
    "-c",
    [
      "apk add --no-cache openssh-client socat",
      "mkdir -p /ssh-auth",
      `chmod 755 ${SSH_AGENT_DIRECTORY}`,
      `rm -f ${SSH_AGENT_SOCKET} /tmp/ssh-agent.sock /ssh-auth/ssh-agent.sock`,
      "eval $(ssh-agent -s -a /tmp/ssh-agent.sock)",
      // Load host keys from ~/.ssh
      // ssh-add without args loads id_rsa, id_dsa, id_ecdsa, id_ed25519
      // Skip passphrase-protected keys gracefully (no stdin in container)
      "(ssh-add 2>/dev/null || true)",
      // ssh-agent checks peer UIDs even with 0666 permissions; socat connects as the agent's owner.
      `(socat UNIX-LISTEN:${SSH_AGENT_SOCKET},fork,mode=0666 UNIX-CONNECT:/tmp/ssh-agent.sock &)`,
      "exec socat UNIX-LISTEN:/ssh-auth/ssh-agent.sock,fork,mode=0666 UNIX-CONNECT:/tmp/ssh-agent.sock",
    ].join(" && "),
  ],
  storage: [{ store: SSH_AGENT_VOLUME, target: SSH_AGENT_DIRECTORY, scope: "app" }],
  mounts: [
    {
      type: "bind",
      source: join(makeLandoPaths().roots.userDataRoot, "ssh"),
      target: "/ssh-auth",
      readOnly: false,
    },
    {
      type: "bind",
      source: "~/.ssh",
      target: "/root/.ssh",
      readOnly: true,
    },
  ],
  environment: {
    SSH_AUTH_SOCK: SSH_AGENT_SOCKET,
  },
});

/**
 * Default export: an Effect that yields the SSH agent sidecar global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 */
const sshAgentGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(sshAgentServiceConfig);

export default sshAgentGlobalService;
