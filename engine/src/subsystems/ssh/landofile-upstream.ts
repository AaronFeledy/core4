/**
 * Optional cwd Landofile peek for the shared ssh-agent sidecar knob.
 * Missing or unloadable Landofiles stay silent; this is not app discovery.
 */
import { Effect } from "effect";

import type { SshAgentConfig } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { loadUserLandofile } from "../../landofile/app-resolution.ts";

export const peekLandofileSshAgent = (): Effect.Effect<SshAgentConfig | undefined> =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(LandofileService);
    if (service._tag === "None") return undefined;
    const landofile = yield* loadUserLandofile(service.value).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    return landofile?.sshAgent;
  });
