import type { DestroyAppResult } from "@lando/sdk/app";
import { PostDestroyEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { TeardownPlan } from "./destroy-plan.ts";
import { runAppEvent } from "./events.ts";

export const publishDestroyCompletion = Effect.fnUntraced(function* (
  plan: TeardownPlan & { readonly evidence: NonNullable<TeardownPlan["evidence"]> },
  result: DestroyAppResult & { readonly outcome: NonNullable<DestroyAppResult["outcome"]> },
) {
  const events = yield* EventService;
  const authored = plan.authored?.plan;
  const evidence = plan.evidence;
  for (const app of plan.refs) {
    const post = PostDestroyEvent.make({
      app,
      evidence,
      outcome: result.outcome,
      timestamp: DateTime.nowUnsafe(),
    });
    if (authored !== undefined && app.id === authored.id && app.root === authored.root)
      yield* runAppEvent(authored, "post-destroy", post);
    yield* events.publish(post);
  }
});
