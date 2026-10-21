import { Context, Duration, Effect, Exit, Option, Ref } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";

import { CommandWarnings } from "../landofile/command-warnings.ts";

/** Observation stops after this budget; anything still unobserved is reported as unverified. */
export const INCOMPLETE_START_OBSERVATION_BUDGET = Duration.seconds(1);

/**
 * Set by the outermost start-like operation. Nested starts (restart and rebuild run start)
 * share its first mutated plan instead of reporting twice or narrowing inventory to a subset.
 */
const IncompleteStartAttempt = Context.Reference<Ref.Ref<AppPlan | undefined> | undefined>(
  "@lando/engine/IncompleteStartAttempt",
  { defaultValue: () => undefined },
);

/** Records that this attempt is about to change app resources. */
export const markStartMutation = (plan: AppPlan): Effect.Effect<void> =>
  Effect.flatMap(IncompleteStartAttempt, (attempt) =>
    attempt === undefined ? Effect.void : Ref.update(attempt, (first) => first ?? plan),
  );

const listed = (names: ReadonlyArray<string>): string => (names.length === 0 ? "none" : names.join(", "));

const inventoryNotice = Effect.fnUntraced(function* (plan: AppPlan) {
  const services = Object.values(plan.services).map((service) => service.name);
  // Keep each completed observation even when the shared deadline interrupts its siblings.
  const observed = new Map<string, ServiceRuntimeInfo>();
  yield* Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
    if (Option.isNone(registry)) return;
    const provider = yield* registry.value.select(plan);
    yield* Effect.forEach(
      services,
      (service) =>
        Effect.suspend(() => provider.inspect({ app: plan.id, service, plan })).pipe(
          Effect.tap((runtime) => Effect.sync(() => observed.set(service, runtime))),
          // Inventory failure, including a provider defect, is unknown rather than a command failure.
          Effect.ignoreCause,
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.interruptible,
    Effect.timeoutOption(INCOMPLETE_START_OBSERVATION_BUDGET),
    Effect.ignoreCause,
  );
  const running: string[] = [];
  const stopped: string[] = [];
  const unverified: string[] = [];
  for (const service of services) {
    const runtime = observed.get(service);
    if (runtime === undefined) {
      unverified.push(service);
      continue;
    }
    const state = runtime.state ?? runtime.status;
    // Only a verified absent container is omitted; an id-less unknown is still unknown.
    if (runtime.containerId === undefined && (state === "stopped" || state === "missing")) continue;
    if (runtime.containerId === undefined) {
      unverified.push(service);
      continue;
    }
    switch (state) {
      case "running":
        running.push(service);
        break;
      case "restarting":
        running.push(`${service} (restarting)`);
        break;
      case "created":
      case "stopped":
      case "paused":
      case "exited":
      case "dead":
        stopped.push(service);
        break;
      default:
        unverified.push(service);
    }
  }
  return `Start did not complete. Resources were left in place. Running: ${listed(running)}; created/stopped: ${listed(stopped)}; unverified: ${listed(unverified)}. Agent forwarding/file sync remain active where established. Inspect \`lando info\` and \`lando logs\`; fix the reported error, then run \`lando start\`. Run \`lando stop\` to shut down or \`lando destroy\` to remove resources; volumes require \`--volumes\`.`;
});

/**
 * Adds one human-only notice after a failed or interrupted start-like operation, listing what
 * the attempt left in place. Machine output and library callers get no notice.
 */
export const withIncompleteStartNotice = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<A, E, R> {
  const owner = yield* IncompleteStartAttempt;
  const warnings = yield* Effect.serviceOption(CommandWarnings);
  if (owner !== undefined || Option.isNone(warnings) || warnings.value.machineOutput) return yield* effect;
  const notices = warnings.value;
  const mutated = yield* Ref.make<AppPlan | undefined>(undefined);
  return yield* effect.pipe(
    Effect.provideService(IncompleteStartAttempt, mutated),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Ref.get(mutated).pipe(
            Effect.flatMap((plan) =>
              plan !== undefined
                ? inventoryNotice(plan)
                : Effect.succeed(
                    "Start did not complete. No app resources changed. Fix the reported error, then run `lando start`.",
                  ),
            ),
            Effect.flatMap(notices.addFailureNotice),
            // Even a defective notice sink must not append to the original command cause.
            Effect.ignoreCause,
          ),
    ),
  );
});
