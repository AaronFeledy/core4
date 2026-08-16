/**
 * SSH agent sidecar global service.
 *
 * Runs a real ssh-agent that forwards SSH keys from the host into app networks.
 * Apps opt in via `sshAgent: true`.
 */
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

const sshAgentServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "lando",
  image: "alpine:3.20",
  command: [
    "sh",
    "-c",
    [
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
    ].join(" && "),
  ],
  mounts: [
    {
      type: "bind",
      source: "${LANDO_USER_DATA_ROOT}/ssh",
      target: "/ssh-auth",
      readOnly: false,
    },
    {
      type: "bind",
      source: "${HOME}/.ssh",
      target: "/root/.ssh",
      readOnly: true,
    },
  ],
  environment: {
    SSH_AUTH_SOCK: "/ssh-auth/ssh-agent.sock",
  },
});

/**
 * Default export: an Effect that yields the SSH agent sidecar global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 */
const sshAgentGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(sshAgentServiceConfig);

export default sshAgentGlobalService;
