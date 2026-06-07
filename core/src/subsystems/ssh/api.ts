/**
 * SSH and host identity.
 *
 * Required behaviors:
 * - Host SSH keys from `~/.ssh` and managed Lando keys are forwarded or
 *   copied per provider capability.
 * - `keys: false` disables key loading.
 * - A string array allowlists keys (`keys: ["~/.ssh/work_id"]`).
 * - Passphrase-protected keys work through an active SSH agent when
 *   available.
 * - Host identity env (`LANDO_HOST_USER`, `LANDO_HOST_UID`,
 *   `LANDO_HOST_GID`, `LANDO_HOST_HOME`) is injected when known.
 * - Provider limitations are surfaced clearly on Windows, remote
 *   providers, and rootless runtimes.
 *
 * **SSH-agent design:**
 * v4 ships an `ssh-agent` feature for `type: lando` services. The default
 * implementation uses a dedicated SSH-agent **sidecar** rather than
 * directly bind-mounting the host agent socket into every service. This
 * eliminates the v3-era pattern where every service had unrestricted
 * access to the host SSH agent. The sidecar is opt-in via the
 * `sshAgent.sidecar: true` global setting (default `true` in v4) or
 * per-service `packages.ssh-agent.sidecar: true`.
 *
 * Plugins MAY provide alternate SSH-agent implementations via the
 * `features` contribution surface.
 *
 * Status: stub. The feature itself lives in `@lando/service-lando`'s
 * `lando.ssh-agent` feature.
 */

export const SSH_AGENT_FEATURE_ID = "lando.ssh-agent" as const;

import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import { SshService } from "@lando/sdk/services";

export { SshService };

const SSH_UNAVAILABLE_ID = "unavailable" as const;
const SSH_UNAVAILABLE_MESSAGE =
  "SshService requires the SSH sidecar. Run `lando setup` to install the SSH sidecar (available in with US-103 full implementation).";

export const SshServiceUnavailableLive = Layer.succeed(SshService, {
  id: SSH_UNAVAILABLE_ID,
  setup: (_opts) =>
    Effect.fail(new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: SSH_UNAVAILABLE_ID })),
  getAgentSocket: (_appId) =>
    Effect.fail(new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: SSH_UNAVAILABLE_ID })),
});
