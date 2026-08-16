/**
 * SSH agent sidecar global service.
 *
 * Runs a real ssh-agent that forwards SSH keys from the host into app networks.
 * Apps opt in via `sshAgent: true`.
 */
import { Effect } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";

export default Effect.succeed({
  name: "ssh-agent",
  type: "lando",
  image: "alpine:3.20",
  command: [
    "sh",
    "-c",
    "apk add --no-cache openssh-client && " +
      "mkdir -p /ssh-auth && " +
      "eval $(ssh-agent -s -a /ssh-auth/ssh-agent.sock) && " +
      "chmod 777 /ssh-auth/ssh-agent.sock && " +
      "tail -f /dev/null",
  ],
  volumes: [
    {
      type: "bind",
      source: "${LANDO_USER_DATA_ROOT}/ssh",
      target: "/ssh-auth",
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
} satisfies ServiceConfig);
