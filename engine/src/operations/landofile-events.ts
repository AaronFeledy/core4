import { DateTime, Effect, Option, Result } from "effect";

import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import { AppPlanner, EventService, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { presentLandofileLayers, representativeLandofileLayer } from "@lando/landofile/layers";
import { RedactionService } from "@lando/redaction/service";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";

type LandofileEventSource =
  | { readonly kind: "plan"; readonly plan: AppPlan }
  | {
      readonly kind: "skip";
      readonly level: "info" | "warn";
      readonly reason: string;
      /** Loader or planner text; it may quote authored values, so it is published only redacted. */
      readonly detail?: string;
    };

const skip = (level: "info" | "warn", reason: string, detail?: string): LandofileEventSource => ({
  kind: "skip",
  level,
  reason,
  ...(detail === undefined ? {} : { detail }),
});

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\.$/u, "");

/** Whether the applied root itself holds a Landofile; a Landofile in a parent folder is another app's. */
const landofilePresentAt = (root: string): Effect.Effect<Result.Result<boolean, string>> =>
  Effect.tryPromise({
    try: () => presentLandofileLayers(root),
    catch: errorText,
  }).pipe(
    Effect.map((layers) => representativeLandofileLayer(layers) !== undefined),
    Effect.result,
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
  const loadFailure = `the Landofile in ${root} could not be loaded`;
  const present = yield* landofilePresentAt(root);
  if (Result.isFailure(present)) return skip("warn", loadFailure, present.failure);
  if (!present.success) return skip("info", `no Landofile in ${root}`);
  const planner = yield* AppPlanner;
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planned = yield* loadUserLandofileAt(landofileService, root).pipe(
    Effect.flatMap((landofile) =>
      registry.capabilities.pipe(Effect.flatMap((capabilities) => planner.plan(landofile, capabilities))),
    ),
    Effect.map((plan): LandofileEventSource => ({ kind: "plan", plan })),
    Effect.catch((error) => Effect.succeed(skip("warn", loadFailure, errorText(error)))),
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
  const redaction = yield* Effect.serviceOption(RedactionService);
  // Without a redactor the loader text stays out of the notice rather than risk leaking a value.
  const detail =
    source.detail === undefined || Option.isNone(redaction)
      ? ""
      : `. ${(
          yield* redaction.value.forProfile("secrets", {
            sourceEnv: process.env,
            redactionTokens: collectAppPlanRedactionTokens(target.plan),
          })
        ).redactString(source.detail)}`;
  const body = `Skipping Landofile events for ${target.plan.name}: ${source.reason}${detail}.`;
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
