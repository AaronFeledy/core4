/**
 * SSH agent sidecar global service.
 *
 * Loads default host key files and publishes the agent inside the managed runtime.
 */
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";

import { ServiceConfig } from "@lando/sdk/schema";
import {
  SSH_AGENT_DIRECTORY,
  SSH_AGENT_HOST_DIRECTORY,
  SSH_AGENT_HOST_SOCKET,
  SSH_AGENT_SOCKET,
  SSH_AGENT_VOLUME,
} from "./socket.ts";

export const createSshAgentServiceConfig = (paths = makeLandoPaths()): ServiceConfig => {
  // Native Windows bind mounts cannot carry Unix-domain sockets. The managed
  // provider delivers the agent through its shared runtime volume instead.
  const publishesHostSocket = paths.platform !== "win32";
  return Schema.decodeUnknownSync(ServiceConfig)({
    api: 4,
    type: "compose",
    appMount: false,
    image: "alpine:3.20",
    // Bake the tools into the image so sidecar starts never need the network.
    build: {
      artifact: [{ run: "apk add --no-cache openssh-client socat", user: "root" }],
    },
    // The sidecar keeps no per-user state, so there is no home to persist.
    home: false,
    command: [
      "sh",
      "-c",
      [
        ...(publishesHostSocket ? [`mkdir -p ${SSH_AGENT_HOST_DIRECTORY}`] : []),
        `chmod 755 ${SSH_AGENT_DIRECTORY}`,
        `rm -f ${SSH_AGENT_SOCKET} /tmp/ssh-agent.sock${publishesHostSocket ? ` ${SSH_AGENT_HOST_SOCKET}` : ""}`,
        "eval $(ssh-agent -s -a /tmp/ssh-agent.sock)",
        // Load host keys from ~/.ssh
        // ssh-add without args loads id_rsa, id_dsa, id_ecdsa, id_ed25519
        // Skip passphrase-protected keys gracefully (no stdin in container)
        "(ssh-add 2>/dev/null || true)",
        // ssh-agent checks peer UIDs even with 0666 permissions; socat connects as the agent's owner.
        ...(publishesHostSocket
          ? [
              `(socat UNIX-LISTEN:${SSH_AGENT_SOCKET},fork,mode=0666 UNIX-CONNECT:/tmp/ssh-agent.sock &)`,
              `exec socat UNIX-LISTEN:${SSH_AGENT_HOST_SOCKET},fork,mode=0666 UNIX-CONNECT:/tmp/ssh-agent.sock`,
            ]
          : [`exec socat UNIX-LISTEN:${SSH_AGENT_SOCKET},fork,mode=0666 UNIX-CONNECT:/tmp/ssh-agent.sock`]),
      ].join(" && "),
    ],
    storage: [{ store: SSH_AGENT_VOLUME, target: SSH_AGENT_DIRECTORY, scope: "app" }],
    mounts: [
      ...(publishesHostSocket
        ? [
            {
              type: "bind",
              source: join(paths.roots.userDataRoot, "ssh"),
              target: SSH_AGENT_HOST_DIRECTORY,
              readOnly: false,
            },
          ]
        : []),
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
};

/**
 * Default export: an Effect that yields the SSH agent sidecar global `ServiceConfig`.
 * The global-service loader runs this Effect and decodes the result.
 */
const sshAgentGlobalService: Effect.Effect<ServiceConfig> = Effect.sync(() => createSshAgentServiceConfig());

export default sshAgentGlobalService;
