import { Context, type Effect } from "effect";

import type { AbsolutePath, LoadScopedLandofile } from "../schema/index.ts";
import type { UserLandofileError } from "./landofile.ts";

/**
 * Canonical user-app Landofile resolution for SDK consumers (plugin commands).
 * Applies reserved-app-id and Lando version-constraint checks that raw
 * `LandofileService.discover` does not.
 */
export class UserAppResolver extends Context.Service<
  UserAppResolver,
  {
    /** Load the user Landofile for the current discovery cwd. */
    readonly current: Effect.Effect<LoadScopedLandofile, UserLandofileError>;
    /** Load the user Landofile at exactly `root` (no upward walk beyond that root). */
    readonly load: (root: AbsolutePath) => Effect.Effect<LoadScopedLandofile, UserLandofileError>;
  }
>()("@lando/core/UserAppResolver") {}
