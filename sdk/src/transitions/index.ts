/**
 * Declared transitions for lifecycles whose state outlives one call: a journal,
 * a registry entry, a receipt, or an exclusive claim. Each operation names the
 * states it may leave and the state it enters, so every write consults one table
 * instead of re-deriving the rule at its call site. The helpers are pure and
 * Effect-free; callers run `step` inside the locked `StateBucket.modify` (or
 * `Ref.modify`) that persists the result, so the check and the write cannot race.
 */

/**
 * One operation's edge. `from` lists the states the operation may leave; omit
 * `to` when the operation rewrites a record without changing its state.
 * `settledIn` lists states that already reflect the operation, so repeating it
 * there (a resumed attempt replaying its steps) is a no-op rather than a failure.
 */
export interface TransitionEdge<State extends string> {
  readonly from: ReadonlyArray<State>;
  readonly to?: State;
  readonly settledIn?: ReadonlyArray<State>;
}

export type TransitionVerdict<State extends string> =
  | { readonly _tag: "Advance"; readonly from: State; readonly to: State }
  | { readonly _tag: "Settled"; readonly from: State }
  | {
      readonly _tag: "Illegal";
      readonly from: State;
      readonly to: State | undefined;
      readonly accepts: ReadonlyArray<State>;
    };

export interface Transitions<State extends string, Operation extends string> {
  readonly edges: { readonly [K in Operation]: TransitionEdge<State> };
  readonly step: (operation: Operation, from: State) => TransitionVerdict<State>;
}

/** Fix the state union first so each table is checked against it, then infer operations from the keys. */
export const defineTransitions =
  <State extends string>() =>
  <Operation extends string>(
    edges: {
      readonly [K in Operation]: TransitionEdge<State>;
    },
  ): Transitions<State, Operation> => ({
    edges,
    step: (operation, from) => {
      const edge = edges[operation];
      if (edge.from.includes(from)) return { _tag: "Advance", from, to: edge.to ?? from };
      if (edge.settledIn?.includes(from)) return { _tag: "Settled", from };
      return { _tag: "Illegal", from, to: edge.to, accepts: edge.from };
    },
  });

export const illegalTransitionMessage = <State extends string>(
  subject: string,
  operation: string,
  verdict: Extract<TransitionVerdict<State>, { readonly _tag: "Illegal" }>,
): string => {
  const accepts = verdict.accepts.join(" or ");
  return verdict.to === undefined
    ? `${subject} cannot ${operation} while ${verdict.from}; ${operation} only applies while ${accepts}.`
    : `${subject} cannot ${operation} while ${verdict.from}; ${operation} only moves ${accepts} to ${verdict.to}.`;
};
