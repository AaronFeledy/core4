import { DateTime, Effect, Option, Result, Schema } from "effect";

import type { LandofileEventsOutcome } from "@lando/sdk/app";
import { LandofileEventsSkippedError } from "@lando/sdk/errors";
import { MessageInfoEvent, MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  EventService,
  InteractionService,
  LandofileService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

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
  presentLandofileLayers(root).pipe(
    Effect.mapError(errorText),
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

export const LandofileEventsOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ran") }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
]);

export interface LandofileEventPlan {
  /** The plan whose steps the operation runs; carries no events when they were skipped. */
  readonly plan: AppPlan;
  readonly outcome: LandofileEventsOutcome;
  /** `warn` when a Landofile is present but unusable; `info` when there is none to use. */
  readonly skipLevel?: "info" | "warn";
}

/**
 * The plan whose Landofile `events:` and `hostEvents` steps a lifecycle operation runs.
 *
 * A desired target (one resolved from a Landofile) already carries them. A target read back
 * from applied state carries none, because Landofile events come from the current Landofile
 * rather than from whatever was applied: this plans the Landofile at the applied root and
 * returns it when it still describes the applied app. Otherwise it publishes one notice and
 * returns the applied plan with no events, so the operation runs its lifecycle without
 * Landofile steps and reports that in its result.
 */
export const resolveLandofileEventPlan = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
): Effect.fn.Return<
  LandofileEventPlan,
  never,
  AppPlanner | EventService | LandofileService | RuntimeProviderRegistry
> {
  if (target.landofile !== undefined) return { plan: target.plan, outcome: { status: "ran" } };
  const source = yield* planLandofileEvents(target);
  if (source.kind === "plan") return { plan: source.plan, outcome: { status: "ran" } };
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
  const reason = `${source.reason}${detail}`;
  const body = `Skipping Landofile events for ${target.plan.name}: ${reason}.`;
  const timestamp = DateTime.nowUnsafe();
  yield* events
    .publish(
      source.level === "warn"
        ? MessageWarnEvent.make({ body, timestamp })
        : MessageInfoEvent.make({ body, timestamp }),
    )
    .pipe(Effect.ignore);
  return {
    plan: { ...target.plan, events: {} },
    outcome: { status: "skipped", reason },
    skipLevel: source.level,
  };
});

const skippedError = (reason: string, message: string) =>
  new LandofileEventsSkippedError({
    message,
    reason,
    remediation:
      "Fix the Landofile so its pre-destroy steps can run, or rerun with --yes to remove the data without them.",
  });

/**
 * A present Landofile that cannot source hooks may declare a `pre-destroy` backup step. When
 * destroy would also remove data, that is a decision for the caller: `--yes` accepts it, an
 * interactive session is asked, and anything else fails closed.
 */
export const confirmDestroyWithoutLandofileEvents = Effect.fnUntraced(function* (
  outcome: LandofileEventsOutcome,
  yes: boolean,
): Effect.fn.Return<void, LandofileEventsSkippedError> {
  if (yes || outcome.status !== "skipped") return;
  const interaction = yield* Effect.serviceOption(InteractionService);
  if (Option.isNone(interaction) || !(yield* interaction.value.isInteractive)) {
    return yield* skippedError(
      outcome.reason,
      `Landofile events cannot run (${outcome.reason}), and this destroy removes data.`,
    );
  }
  const confirmed = yield* interaction.value
    .confirm({
      message: `Landofile events cannot run (${outcome.reason}). Remove this app's data without them?`,
      default: false,
    })
    .pipe(
      Effect.scoped,
      Effect.catch(() => Effect.succeed(false)),
    );
  if (!confirmed) {
    return yield* skippedError(outcome.reason, "Destroy cancelled. The app was not changed.");
  }
});
