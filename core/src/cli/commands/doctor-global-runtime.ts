import { globalObserveProviderId } from "@lando/engine/global-app/placement";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";

export const idleGlobalProvider = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  const global = yield* Effect.serviceOption(GlobalAppService);
  if (Option.isNone(registry)) return undefined;
  const id = Option.isSome(global)
    ? yield* globalObserveProviderId.pipe(
        Effect.provideService(GlobalAppService, global.value),
        Effect.provideService(RuntimeProviderRegistry, registry.value),
      )
    : undefined;
  const provider = yield* registry.value.select(id);
  return (yield* provider.getStatus).state === "idle" ? provider.id : undefined;
}).pipe(Effect.catch(() => Effect.succeed(undefined)));
