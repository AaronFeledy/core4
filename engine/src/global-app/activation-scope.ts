import { GlobalAppError } from "@lando/sdk/errors";
import { Context, Effect, Ref, Semaphore } from "effect";

export type GlobalActivationReservation = {
  readonly policy: string;
  readonly globalRoot: string;
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly root: string;
    readonly kind: "user" | "scratch" | "global";
  };
  readonly services: ReadonlyArray<string>;
};

type PolicyOperation = "enable" | "disable" | "reconcile";
type ActivationState = {
  readonly entries: ReadonlyArray<GlobalActivationReservation>;
  readonly epoch: number;
  readonly policyOwner: { readonly token: symbol; readonly operation: PolicyOperation } | undefined;
  readonly routeOwner: symbol | undefined;
};

/** Forks share one coordinator's state; separate coordinators share only their file leases. */
export const GlobalActivationScope = Context.Reference<
  { readonly state: Ref.Ref<ActivationState>; readonly policyGate: Semaphore.Semaphore } | undefined
>("@lando/engine/GlobalActivationScope", { defaultValue: () => undefined });

export const withGlobalActivationScope = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>) {
  const inherited = yield* GlobalActivationScope;
  if (inherited !== undefined) return yield* body;
  const state = yield* Ref.make<ActivationState>({
    entries: [],
    epoch: 0,
    policyOwner: undefined,
    routeOwner: undefined,
  });
  const policyGate = yield* Semaphore.make(1);
  return yield* body.pipe(Effect.provideService(GlobalActivationScope, { state, policyGate }));
});

const missingScope = (operation = "consumer-admission") =>
  new GlobalAppError({
    operation,
    message: "The global mutation coordinator is not held.",
    remediation: "Run this mutation through the global policy coordinator.",
  });

/** Gate only state publication and policy CAS; lifecycle callbacks execute outside it. */
export const withGlobalActivationPolicyGate = Effect.fnUntraced(function* <A, E, R>(
  body: Effect.Effect<A, E, R>,
) {
  const scope = yield* GlobalActivationScope;
  if (scope === undefined) return yield* Effect.fail(missingScope());
  return yield* scope.policyGate.withPermits(1)(body);
});

export const globalActivationEpoch = Effect.gen(function* () {
  const scope = yield* GlobalActivationScope;
  return scope === undefined ? 0 : (yield* Ref.get(scope.state)).epoch;
});

export const activeGlobalPolicyChange = Effect.gen(function* () {
  const scope = yield* GlobalActivationScope;
  return scope === undefined ? undefined : (yield* Ref.get(scope.state)).policyOwner?.operation;
});

/** Saved intent and its cleanup form one operation, including nested command callbacks. */
export const withGlobalPolicyChange = Effect.fnUntraced(function* <A, E, R>(
  operation: PolicyOperation,
  body: Effect.Effect<A, E, R>,
) {
  const scope = yield* GlobalActivationScope;
  if (scope === undefined) return yield* Effect.fail(missingScope());
  const owner = { token: Symbol(operation), operation };
  return yield* Effect.acquireUseRelease(
    withGlobalActivationPolicyGate(
      Ref.modify(scope.state, (state) =>
        state.policyOwner === undefined && state.routeOwner === undefined
          ? ([true, { ...state, policyOwner: owner }] as const)
          : ([false, state] as const),
      ).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? Effect.void
            : Effect.fail(
                new GlobalAppError({
                  operation: "policy-coordination",
                  message: "A global policy change or route publication is still in progress.",
                  remediation:
                    "Wait for the current policy change or route publication to complete, then retry.",
                }),
              ),
        ),
      ),
    ),
    () => body,
    () =>
      withGlobalActivationPolicyGate(
        Ref.update(scope.state, (state) =>
          state.policyOwner?.token === owner.token ? { ...state, policyOwner: undefined } : state,
        ),
      ),
  );
});

/** Retain route ownership through asynchronous writes so policy cleanup cannot be overwritten. */
export const withGlobalRoutePublication = Effect.fnUntraced(function* <A, E, R>(
  body: Effect.Effect<A, E, R>,
) {
  const scope = yield* GlobalActivationScope;
  if (scope === undefined) return yield* Effect.fail(missingScope("route-coordination"));
  const owner = Symbol("global-routes");
  return yield* Effect.acquireUseRelease(
    withGlobalActivationPolicyGate(
      Ref.modify(scope.state, (state) =>
        state.policyOwner === undefined && state.routeOwner === undefined
          ? ([true, { ...state, routeOwner: owner }] as const)
          : ([false, state] as const),
      ).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? Effect.void
            : Effect.fail(
                new GlobalAppError({
                  operation: "route-coordination",
                  message: "A global policy change or route publication is still in progress.",
                  remediation:
                    "Wait for the current policy change or route publication to complete, then retry.",
                }),
              ),
        ),
      ),
    ),
    () => body,
    () =>
      withGlobalActivationPolicyGate(
        Ref.update(scope.state, (state) =>
          state.routeOwner === owner ? { ...state, routeOwner: undefined } : state,
        ),
      ),
  );
});
