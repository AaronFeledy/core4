/**
 * SSH agent sidecar global service.
 *
 * Runs a real ssh-agent that forwards SSH keys from the host into app networks.
 * Apps opt in via `sshAgent: true`.
 */
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";

import { ServiceConfig } from "@lando/sdk/schema";

// Compose realizes authored bind mounts; the socket directory must be shared with the host so
// the per-app agent relay can reach it.
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
    SSH_AUTH_SOCK: "/ssh-auth/ssh-agent.sock",
  },
});

/**
 * Default export: an Effect that yields the SSH agent sidecar global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 */
const sshAgentGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(sshAgentServiceConfig);

export default sshAgentGlobalService;
