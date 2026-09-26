/**
 * Cwd Landofile peek for the shared ssh-agent sidecar knob.
 * `LandofileService` is required so stripped callers cannot drop this source.
 * Missing or unloadable Landofiles stay silent; this is not app discovery.
 */
import { Effect } from "effect";

import type { SshAgentConfig } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { loadUserLandofile } from "../../landofile/app-resolution.ts";

export const peekLandofileSshAgent = (): Effect.Effect<SshAgentConfig | undefined, never, LandofileService> =>
  Effect.gen(function* () {
    const service = yield* LandofileService;
    const landofile = yield* loadUserLandofile(service).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );
    return landofile?.sshAgent;
  });
