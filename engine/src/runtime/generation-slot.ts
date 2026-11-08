/**
 * Lifecycle of one cached app generation slot.
 *
 * A slot is `building` until its generation builds, `ready` while it is the app's current
 * generation, `superseded` once a newer selection replaces it, and `closed` when its scope closes:
 * after a failed build, or when a superseded slot loses its last lease. Leases and the current
 * record are data carried through the same edges, so every change checks the table and writes
 * under one `Ref.modify`.
 */
import { defineTransitions, illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { Effect, Ref, Result } from "effect";

export type GenerationSlotPhase = "building" | "ready" | "superseded" | "closed";

export const generationSlotTransitions = defineTransitions<GenerationSlotPhase>()({
  lease: { from: ["building", "ready"] },
  release: { from: ["building", "ready", "superseded"], settledIn: ["closed"] },
  ready: { from: ["building"], to: "ready", settledIn: ["superseded", "closed"] },
  finish: { from: ["superseded"], settledIn: ["closed"] },
  refresh: { from: ["ready"], settledIn: ["superseded", "closed"] },
  supersede: { from: ["building", "ready"], to: "superseded" },
  fail: { from: ["building", "superseded"], to: "closed", settledIn: ["closed"] },
  close: { from: ["superseded"], to: "closed", settledIn: ["closed"] },
});

export type GenerationSlotOperation = keyof typeof generationSlotTransitions.edges;

export interface GenerationSlotState<Record, Selection> {
  readonly selection: Selection;
  readonly phase: GenerationSlotPhase;
  readonly leases: number;
  /** The latest projection of the built generation; absent until it builds. */
  readonly record: Record | undefined;
}

export const initialSlotState = <Record, Selection>(
  selection: Selection,
): GenerationSlotState<Record, Selection> => ({
  selection,
  phase: "building",
  leases: 1,
  record: undefined,
});

/**
 * Apply `operation` to the slot, deriving the data of the next state from the current one.
 * Returns the stored state; an illegal edge is an invariant violation of the slot owner.
 */
export const stepSlot = <Record, Selection>(
  state: Ref.Ref<GenerationSlotState<Record, Selection>>,
  operation:
    | GenerationSlotOperation
    | ((current: GenerationSlotState<Record, Selection>) => GenerationSlotOperation),
  next: (
    current: GenerationSlotState<Record, Selection>,
  ) => Omit<GenerationSlotState<Record, Selection>, "phase"> = (current) => current,
): Effect.Effect<GenerationSlotState<Record, Selection>> =>
  Ref.modify(
    state,
    (
      current,
    ): readonly [
      Result.Result<GenerationSlotState<Record, Selection>, string>,
      GenerationSlotState<Record, Selection>,
    ] => {
      const selectedOperation = typeof operation === "string" ? operation : operation(current);
      const plan = planTransition(generationSlotTransitions, selectedOperation, current.phase, (phase) => ({
        ...next(current),
        phase,
      }));
      switch (plan._tag) {
        case "Keep":
          return [Result.succeed(current), current];
        case "Write": {
          const stored = plan.value ?? current;
          return [Result.succeed(stored), stored];
        }
        case "Illegal":
          return [
            Result.fail(illegalTransitionMessage("App generation", selectedOperation, plan.verdict)),
            current,
          ];
      }
    },
  ).pipe(
    Effect.flatMap((verdict) =>
      Result.isSuccess(verdict) ? Effect.succeed(verdict.success) : Effect.die(verdict.failure),
    ),
  );

/** Close a superseded slot that holds no lease; true only for the call that closed it. */
export const closeIfIdle = <Record, Selection>(
  state: Ref.Ref<GenerationSlotState<Record, Selection>>,
): Effect.Effect<boolean> =>
  Ref.modify(state, (current) => {
    if (current.phase !== "superseded" || current.leases > 0) return [false, current] as const;
    const plan = planTransition(generationSlotTransitions, "close", current.phase, (phase) => ({
      ...current,
      phase,
    }));
    return plan._tag === "Write" && plan.value !== null
      ? ([true, plan.value] as const)
      : ([false, current] as const);
  });
