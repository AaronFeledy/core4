import { DateTime, Effect } from "effect";

import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import { AppPlanner, EventService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { findAppRoot } from "@lando/landofile/discovery";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";

type LandofileEventSource =
  | { readonly kind: "plan"; readonly plan: AppPlan }
  | { readonly kind: "skip"; readonly level: "info" | "warn"; readonly reason: string };

const skip = (level: "info" | "warn", reason: string): LandofileEventSource => ({
  kind: "skip",
  level,
  reason,
});

const landofileAt = (root: string) =>
  Effect.promise(() => findAppRoot(root).catch(() => undefined)).pipe(
    Effect.map((discovered) => discovered === root),
  );

/**
 * Plans the Landofile at the applied root so its events can run against the applied app, or
 * says why that is not possible: no Landofile there, it cannot be loaded, or it describes a
 * different app or provider than the one that is applied.
 */
const planLandofileEvents = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
): Effect.fn.Return<LandofileEventSource, never, AppPlanner | LandofileService | RuntimeProviderRegistry> {
  const root = target.root;
  if (!(yield* landofileAt(root))) return skip("info", `no Landofile in ${root}`);
  const planner = yield* AppPlanner;
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planned = yield* loadUserLandofileAt(landofileService, root).pipe(
    Effect.flatMap((landofile) =>
      registry.capabilities.pipe(Effect.flatMap((capabilities) => planner.plan(landofile, capabilities))),
    ),
    Effect.map((plan): LandofileEventSource => ({ kind: "plan", plan })),
    Effect.catch((error) =>
      Effect.succeed(
        skip("warn", `the Landofile in ${root} could not be loaded. ${error.message.replace(/\.$/u, "")}`),
      ),
    ),
  );
  if (planned.kind === "skip") return planned;
  const desired = planned.plan;
  if (desired.id !== target.plan.id) {
    return skip(
      "warn",
      `the Landofile in ${root} describes app ${desired.id} but ${target.plan.id} is applied`,
    );
  }
  if (desired.root !== root) {
    return skip("warn", `the Landofile in ${root} resolves to app root ${desired.root}`);
  }
  if (desired.provider !== target.plan.provider) {
    return skip(
      "warn",
      `the Landofile in ${root} selects provider ${desired.provider} but ${target.plan.provider} is applied`,
    );
  }
  return planned;
});

/**
 * The plan whose Landofile `events:` and `hostEvents` steps a lifecycle operation runs.
 *
 * A desired target (one resolved from a Landofile) already carries them. A target read back
 * from applied state carries none, because Landofile events come from the current Landofile
 * rather than from whatever was applied: this plans the Landofile at the applied root and
 * returns it when it still describes the applied app. Otherwise it publishes one notice and
 * returns the applied plan with no events, so the operation runs its lifecycle without
 * Landofile steps.
 */
export const resolveLandofileEventPlan = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
): Effect.fn.Return<AppPlan, never, AppPlanner | EventService | LandofileService | RuntimeProviderRegistry> {
  if (target.landofile !== undefined) return target.plan;
  const source = yield* planLandofileEvents(target);
  if (source.kind === "plan") return source.plan;
  const events = yield* EventService;
  const body = `Skipping Landofile events for ${target.plan.name}: ${source.reason}.`;
  const timestamp = DateTime.nowUnsafe();
  yield* events
    .publish(
      source.level === "warn"
        ? MessageWarnEvent.make({ body, timestamp })
        : MessageInfoEvent.make({ body, timestamp }),
    )
    .pipe(Effect.ignore);
  return { ...target.plan, events: {} };
});
