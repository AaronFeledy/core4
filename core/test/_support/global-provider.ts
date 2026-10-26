import type { ProviderId } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect } from "effect";

export const globalAppForProvider = (providerId: ProviderId) =>
  GlobalAppService.of({
    id: "global",
    providerId: Effect.succeed(providerId),
    root: Effect.die("unused global root"),
    paths: Effect.die("unused global paths"),
    ensureRoot: Effect.die("no global creation"),
    ensureRunning: () => Effect.die("no global startup"),
    ensureUserLandofile: Effect.die("no global config mutation"),
    regenerateDist: () => Effect.die("no global materialization"),
  });
