import {
  type AppPlacementError,
  GlobalAppError,
  type GlobalAutoStartError,
  type ServiceNotReadyError,
} from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Context, Effect, Ref } from "effect";
import {
  type GlobalActivationReservation,
  GlobalActivationScope,
  withGlobalActivationPolicyGate,
} from "../global-app/activation-scope.ts";
import { globalPolicyIdentity } from "../global-app/mutation.ts";
import { canonicalMissingAppRoot } from "./app-mutation-lock.ts";

type AdmissionCheck = Effect.Effect<void, AppPlacementError | GlobalAutoStartError | ServiceNotReadyError>;

const ConsumerAdmissionCheck = Context.Reference<AdmissionCheck | undefined>(
  "@lando/engine/ConsumerAdmissionCheck",
  { defaultValue: () => undefined },
);

export const withGlobalConsumerAdmissionCheck = <A, E, R>(
  check: AdmissionCheck,
  body: Effect.Effect<A, E, R>,
) => body.pipe(Effect.provideService(ConsumerAdmissionCheck, check));

/** Reentrant lifecycle hooks can change policy while their consumer owns the global lease. */
export const verifyGlobalConsumerAdmission = Effect.gen(function* () {
  const check = yield* ConsumerAdmissionCheck;
  if (check !== undefined) yield* check;
});

const reservationError = (cause: unknown) =>
  new GlobalAppError({
    operation: "consumer-admission",
    message: "Unable to resolve global activation policy identity.",
    remediation: "Check the global policy and runtime roots and their permissions, then retry.",
    cause,
  });

/** Other processes must own a lease; nested operations share this scoped activation intent. */
export const readGlobalConsumerReservations = Effect.fnUntraced(function* (selected: ReadonlyArray<string>) {
  const policy = yield* globalPolicyIdentity.pipe(Effect.mapError(reservationError));
  const scope = yield* GlobalActivationScope;
  const active = scope === undefined ? [] : (yield* Ref.get(scope.state)).entries;
  const required = new Set(selected);
  return active.filter(
    (reservation) => reservation.policy === policy && reservation.services.some((id) => required.has(id)),
  );
});

export const withGlobalConsumerReservation = Effect.fnUntraced(function* <A, E, R>(
  plan: AppPlan,
  services: ReadonlyArray<string>,
  body: Effect.Effect<A, E, R>,
) {
  const selected = [...new Set(services)].sort();
  if (selected.length === 0) return yield* body;
  const policy = yield* globalPolicyIdentity.pipe(Effect.mapError(reservationError));
  const global = yield* GlobalAppService;
  const paths = yield* global.paths;
  const globalRoot = yield* canonicalMissingAppRoot(paths.root).pipe(Effect.mapError(reservationError));
  const scope = yield* GlobalActivationScope;
  if (scope === undefined)
    return yield* Effect.fail(reservationError("The global mutation coordinator is not held."));
  const reservation: GlobalActivationReservation = {
    policy,
    globalRoot,
    app: {
      id: plan.id,
      name: plan.name,
      root: plan.root,
      kind:
        plan.id === "global"
          ? "global"
          : Object.hasOwn(plan.extensions, "@lando/core/scratch")
            ? "scratch"
            : "user",
    },
    services: selected,
  };
  return yield* Effect.acquireUseRelease(
    withGlobalActivationPolicyGate(
      Ref.modify(scope.state, (state) =>
        state.policyOwner === undefined
          ? ([true, { ...state, entries: [...state.entries, reservation], epoch: state.epoch + 1 }] as const)
          : ([false, state] as const),
      ).pipe(
        Effect.flatMap((added) =>
          added
            ? Effect.void
            : Effect.fail(
                new GlobalAppError({
                  operation: "consumer-admission",
                  message: "A global policy change is still reconciling.",
                  remediation: "Retry application startup after the policy operation finishes.",
                }),
              ),
        ),
      ),
    ),
    () => body,
    () =>
      withGlobalActivationPolicyGate(
        Ref.update(scope.state, (state) => ({
          ...state,
          entries: state.entries.filter((entry) => entry !== reservation),
          epoch: state.epoch + 1,
        })),
      ),
  );
});
