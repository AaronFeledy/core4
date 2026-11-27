import type { AbsolutePath } from "@lando/sdk/schema";
import { LandofileService, UserAppResolver } from "@lando/sdk/services";
import { Effect, Layer } from "effect";

import { loadUserLandofile, loadUserLandofileAt } from "../landofile/app-resolution.ts";

export const layer = Layer.effect(
  UserAppResolver,
  Effect.gen(function* () {
    const landofiles = yield* LandofileService;
    return UserAppResolver.of({
      current: loadUserLandofile(landofiles),
      load: (root: AbsolutePath) => loadUserLandofileAt(landofiles, root),
    });
  }),
);
