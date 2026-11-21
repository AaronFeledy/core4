import { ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Cause, Context, Effect, Exit, Option, Ref } from "effect";

import { CommandWarnings } from "../landofile/command-warnings.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { type ServiceObservation, observeServices } from "./service-observation.ts";

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

export type IncompleteStartVerb = "start" | "restart" | "rebuild";

/** The command the user ran. `services` is set only for a selected restart or rebuild. */
export interface IncompleteStartCommand {
  readonly verb: IncompleteStartVerb;
  readonly services?: readonly string[];
}

const VERB_LABEL: Readonly<Record<IncompleteStartVerb, string>> = {
  start: "Start",
  restart: "Restart",
  rebuild: "Rebuild",
};

const rerunCommand = (command: IncompleteStartCommand): string => {
  const services = command.services ?? [];
  if (services.length === 0) return `lando ${command.verb}`;
  return `lando ${command.verb} ${services.map((service) => `-s ${service}`).join(" ")}`;
};

/**
 * Nothing changed, so the error's own remedy is the advice. The rerun hint is added only when that
 * remedy names no other Lando command, so the footer never contradicts it.
 */
const unchangedNotice = (command: IncompleteStartCommand, failure: unknown): string => {
  const rerun = rerunCommand(command);
  const remediation = taggedErrorRemediation(failure);
  const hasOtherCommand = [...(remediation ?? "").matchAll(/`(lando [^`]+)`/gu)].some(
    ([, named]) => named !== undefined && named !== rerun,
  );
  const summary = `${VERB_LABEL[command.verb]} did not complete. No app resources changed.`;
  const invalidSelection = failure instanceof ServiceNotFoundError && failure.operation === "selectServices";
  return hasOtherCommand || invalidSelection
    ? summary
    : `${summary} Fix the reported error, then run \`${rerun}\`.`;
};

const inventoryNotice = Effect.fnUntraced(function* (plan: AppPlan, command: IncompleteStartCommand) {
  const services = Object.values(plan.services).map((service) => service.name);
  // Anything unobserved within the shared budget, provider selection included, is unverified.
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  const observed: ReadonlyMap<string, ServiceObservation> = Option.isNone(registry)
    ? new Map()
    : yield* observeServices(registry.value.select(plan), plan, services);
  const running: string[] = [];
  const stopped: string[] = [];
  const unverified: string[] = [];
  for (const service of services) {
    const runtime = observed.get(service);
    if (runtime === undefined) {
      unverified.push(service);
      continue;
    }
    // Only a verified absent container is omitted; an id-less unknown is still unknown.
    if (runtime.status === "absent") continue;
    if (runtime.containerId === undefined) {
      unverified.push(service);
      continue;
    }
    switch (runtime.status) {
      case "running":
        running.push(service);
        break;
      case "restarting":
        running.push(`${service} (restarting)`);
        break;
      case "created":
      case "paused":
      case "exited":
      case "dead":
        stopped.push(service);
        break;
      case "removing":
      case "unknown":
        unverified.push(service);
        break;
      default: {
        const exhaustive: never = runtime.status;
        return exhaustive;
      }
    }
  }
  return `${VERB_LABEL[command.verb]} did not complete. Resources were left in place. Running: ${listed(running)}; created/stopped: ${listed(stopped)}; unverified: ${listed(unverified)}. Agent forwarding/file sync remain active where established. Inspect \`lando info\` and \`lando logs\`; fix the reported error, then run \`${rerunCommand(command)}\`. Run \`lando stop\` to shut down or \`lando destroy\` to remove resources; named volumes require \`--volumes\`.`;
});

/**
 * Adds one human-only notice after a failed or interrupted start-like operation, listing what
 * the attempt left in place. Machine output and library callers get no notice.
 */
export const withIncompleteStartNotice = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  command: IncompleteStartCommand,
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
                ? inventoryNotice(plan, command)
                : Effect.succeed(
                    unchangedNotice(command, Option.getOrUndefined(Cause.findErrorOption(exit.cause))),
                  ),
            ),
            Effect.flatMap(notices.addFailureNotice),
            // Even a defective notice sink must not append to the original command cause.
            Effect.ignoreCause,
          ),
    ),
  );
});
