/**
 * SSH agent sidecar global service.
 *
 * A lightweight container that forwards SSH agent sockets from the host
 * into app networks. Apps opt in via `sshAgent: true`.
 */
import { Effect } from "effect";

import type { ServiceConfig } from "@lando/sdk/schema";

export default Effect.succeed({
  name: "ssh-agent",
  type: "lando",
  image: "alpine:3.20",
  command: ["tail", "-f", "/dev/null"],
  volumes: [
    {
      type: "bind",
      source: "${LANDO_USER_DATA_ROOT}/ssh",
      target: "/ssh-sockets",
    },
  ],
} satisfies ServiceConfig);
