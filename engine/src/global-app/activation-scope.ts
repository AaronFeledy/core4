import { GlobalAppError } from "@lando/sdk/errors";
import { defineTransitions } from "@lando/sdk/transitions";
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
  readonly exclusive?: ReadonlyArray<string>;
};

type PolicyOperation = "enable" | "disable" | "reconcile";
/** One exclusive owner at a time; only the claimant's token releases it back to idle. */
type ActivationOwner =
  | { readonly kind: "idle" }
  | { readonly kind: "policy"; readonly token: symbol; readonly operation: PolicyOperation }
  | { readonly kind: "routes"; readonly token: symbol };
type ActivationState = {
  readonly entries: ReadonlyArray<GlobalActivationReservation>;
  readonly epoch: number;
  readonly owner: ActivationOwner;
};

const activationTransitions = defineTransitions<ActivationOwner["kind"]>()({
  "claim-policy": { from: ["idle"], to: "policy" },
  "claim-routes": { from: ["idle"], to: "routes" },
  release: { from: ["policy", "routes"], to: "idle", settledIn: ["idle"] },
});

/** Route publication does not change consumer policy, so only a policy change blocks admission. */
export const admitsGlobalConsumers = (state: ActivationState): boolean => state.owner.kind !== "policy";

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
    owner: { kind: "idle" },
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
  if (scope === undefined) return undefined;
  const { owner } = yield* Ref.get(scope.state);
  return owner.kind === "policy" ? owner.operation : undefined;
});

const withActivationOwner = Effect.fnUntraced(function* <A, E, R>(
  owner: Exclude<ActivationOwner, { readonly kind: "idle" }>,
  coordination: "policy-coordination" | "route-coordination",
  body: Effect.Effect<A, E, R>,
) {
  const scope = yield* GlobalActivationScope;
  if (scope === undefined) return yield* Effect.fail(missingScope(coordination));
  return yield* Effect.acquireUseRelease(
    withGlobalActivationPolicyGate(
      Ref.modify(scope.state, (state) =>
        activationTransitions.step(
          owner.kind === "policy" ? "claim-policy" : "claim-routes",
          state.owner.kind,
        )._tag === "Advance"
          ? ([true, { ...state, owner }] as const)
          : ([false, state] as const),
      ).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? Effect.void
            : Effect.fail(
                new GlobalAppError({
                  operation: coordination,
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
          state.owner.kind !== "idle" &&
          state.owner.token === owner.token &&
          activationTransitions.step("release", state.owner.kind)._tag === "Advance"
            ? { ...state, owner: { kind: "idle" as const } }
            : state,
        ),
      ),
  );
});

/** Saved intent and its cleanup form one operation, including nested command callbacks. */
export const withGlobalPolicyChange = <A, E, R>(operation: PolicyOperation, body: Effect.Effect<A, E, R>) =>
  withActivationOwner({ kind: "policy", token: Symbol(operation), operation }, "policy-coordination", body);

/** Retain route ownership through asynchronous writes so policy cleanup cannot be overwritten. */
export const withGlobalRoutePublication = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  withActivationOwner({ kind: "routes", token: Symbol("global-routes") }, "route-coordination", body);
