import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, ServiceHomePlan, ServicePlan } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { Context, DateTime, Effect } from "effect";

const HomeTransitionNotices = Context.Reference<Set<string> | undefined>(
  "@lando/engine/HomeTransitionNotices",
  {
    defaultValue: () => undefined,
  },
);

export const withHomeTransitionNotices = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const notices = yield* HomeTransitionNotices;
  return yield* notices === undefined
    ? Effect.provideService(effect, HomeTransitionNotices, new Set<string>())
    : effect;
});

const unknownReason = (
  service: ServicePlan,
  home: Extract<ServiceHomePlan, { state: "unknown" }>,
): string => {
  switch (home.reason) {
    case "custom-image":
      return "its image now comes from your Landofile";
    case "no-identity":
      return `${service.type} doesn't declare image users`;
    case "undeclared-user":
      return `${service.type} doesn't know where ${home.user ?? "the planned user"}'s home is`;
    default: {
      const unreachable: never = home.reason;
      return unreachable;
    }
  }
};

export const publishHomeTransitionNotices = Effect.fn("AppOperation.homeTransitionNotices")(function* (
  applied: AppPlan | undefined,
  desired: AppPlan,
) {
  if (applied === undefined) return;
  const notices = yield* HomeTransitionNotices;
  const events = yield* EventService;
  for (const service of Object.values(desired.services)) {
    const old = applied.services[service.name]?.home;
    const home = service.home;
    if (old?.state !== "persisted" || home === undefined) continue;
    let message: string;
    switch (home.state) {
      case "unknown":
        message = `Service ${service.name} no longer keeps its home at ${old.target}: ${unknownReason(service, home)}.`;
        break;
      case "persisted":
        if (home.store === old.store && home.target === old.target) continue;
        message = `Service ${service.name} now keeps its home in a new volume at ${home.target}.`;
        break;
      case "disabled":
      case "authored":
        continue;
      default: {
        const unreachable: never = home;
        return unreachable;
      }
    }
    const key = `${desired.root}\0${service.name}`;
    if (notices?.has(key)) continue;
    notices?.add(key);
    const storage = `storage: [{ store: ${quoteYamlScalar(old.store)}, target: ${quoteYamlScalar(old.target)} }]`;
    yield* events.publish(
      MessageWarnEvent.make({
        body: `${message}\nLando leaves ${old.store} untouched. To reattach it, set ${storage} under services.${service.name} in your Landofile.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }
});
