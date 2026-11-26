import { RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { noRouterInstalled } from "../subsystems/proxy/api.ts";

/** Publication and withdrawal share one router: caller, else captured at build, else none installed. */
export const captureScratchRouter = Effect.map(
  Effect.serviceOption(RouterService),
  (built): Effect.Effect<RouterServiceShape> =>
    Effect.map(Effect.serviceOption(RouterService), (caller) =>
      Option.getOrElse(
        Option.orElse(caller, () => built),
        () => noRouterInstalled,
      ),
    ),
);
