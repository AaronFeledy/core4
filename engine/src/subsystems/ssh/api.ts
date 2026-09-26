export const SSH_AGENT_FEATURE_ID = "lando.ssh-agent" as const;

import { Effect, Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import { SshService } from "@lando/sdk/services";

export { SshService };
export { peekLandofileSshAgent } from "./landofile-upstream.ts";
export { envWithSshAgentUpstream, resolveAuthoredSshAgentUpstream } from "./upstream-env.ts";

const SSH_UNAVAILABLE_ID = "unavailable" as const;
const SSH_UNAVAILABLE_MESSAGE =
  "SshService is not selected. Install and select the bundled SSH agent plugin, then run `lando setup` to provision the SSH sidecar.";

export const SshServiceUnavailableLive = Layer.succeed(SshService, {
  id: SSH_UNAVAILABLE_ID,
  setup: (_opts) =>
    Effect.fail(new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: SSH_UNAVAILABLE_ID })),
  getAgentSocket: (_appId) =>
    Effect.fail(new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: SSH_UNAVAILABLE_ID })),
});
