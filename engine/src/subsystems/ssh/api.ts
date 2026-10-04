export const SSH_AGENT_FEATURE_ID = "lando.ssh-agent" as const;

import { Layer } from "effect";

import { SshError } from "@lando/sdk/errors";
import { SshService } from "@lando/sdk/services";
import { UNAVAILABLE_ID, unavailableOperation } from "../unavailable.ts";

export { SshService };

const SSH_UNAVAILABLE_MESSAGE =
  "SshService is not selected. Install and select the bundled SSH agent plugin, then run `lando setup` to provision the SSH sidecar.";

export const layerUnavailable = Layer.succeed(
  SshService,
  SshService.of({
    id: UNAVAILABLE_ID,
    setup: unavailableOperation(
      () => new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: UNAVAILABLE_ID }),
    ),
    getAgentSocket: unavailableOperation(
      () => new SshError({ message: SSH_UNAVAILABLE_MESSAGE, sshId: UNAVAILABLE_ID }),
    ),
  }),
);
