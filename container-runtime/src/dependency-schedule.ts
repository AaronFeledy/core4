import { Effect } from "effect";

export interface ScheduleEdge {
  /** Node id that must settle first. */
  readonly predecessor: string;
  /** Node id that waits. */
  readonly dependent: string;
  /** When true, a failed/blocked predecessor blocks the dependent. When false, the dependent runs once the predecessor settles, whatever its outcome. */
  readonly required: boolean;
}

export interface ScheduleNode<A> {
  readonly id: string;
  readonly value: A;
}

export interface ScheduleGraph<A> {
  readonly nodes: ReadonlyArray<ScheduleNode<A>>;
  readonly edges: ReadonlyArray<ScheduleEdge>;
}

export type ScheduleOutcome = "succeeded" | "failed" | "blocked";

export type ScheduleResult =
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<string> }
  | { readonly _tag: "Settled"; readonly outcomes: ReadonlyMap<string, ScheduleOutcome> };

export interface ScheduleHandlers<A, E, R> {
  /**
   * Runs one node. `blockedBy` lists ids of REQUIRED predecessors that did not succeed
   * (empty when the node is free to do its real work). The handler decides what a blocked
   * node means for its surface and returns the resulting outcome; the scheduler never
   * invents events or errors of its own.
   */
  readonly run: (
    node: ScheduleNode<A>,
    blockedBy: ReadonlyArray<string>,
  ) => Effect.Effect<ScheduleOutcome, E, R>;
  /** Max nodes run concurrently inside one wave. Defaults to 1 (fully sequential). */
  readonly concurrency?: number;
}

export const runDependencySchedule = <A, E, R>(
  graph: ScheduleGraph<A>,
  handlers: ScheduleHandlers<A, E, R>,
): Effect.Effect<ScheduleResult, E, R> =>
  Effect.gen(function* () {
    const nodes = new Map<string, ScheduleNode<A>>();
    for (const node of graph.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }

    const edges = graph.edges.filter(
      ({ predecessor, dependent }) => nodes.has(predecessor) && nodes.has(dependent),
    );
    const outcomes = new Map<string, ScheduleOutcome>();
    const pending = new Map(nodes);

    while (pending.size > 0) {
      const ready = [...pending.values()]
        .filter((node) =>
          edges.every(({ predecessor, dependent }) => dependent !== node.id || outcomes.has(predecessor)),
        )
        .sort((left, right) => left.id.localeCompare(right.id));

      if (ready.length === 0) {
        return {
          _tag: "Cycle",
          edges: edges
            .filter(({ predecessor, dependent }) => pending.has(predecessor) && pending.has(dependent))
            .map(({ predecessor, dependent }) => `${dependent} -> ${predecessor}`),
        };
      }

      const settled = yield* Effect.forEach(
        ready,
        (node) => {
          const blockedBy = edges.flatMap((edge) => {
            if (edge.dependent !== node.id || !edge.required) return [];
            const outcome = outcomes.get(edge.predecessor);
            return outcome === "failed" || outcome === "blocked" ? [edge.predecessor] : [];
          });
          return handlers.run(node, blockedBy).pipe(Effect.map((outcome) => ({ id: node.id, outcome })));
        },
        { concurrency: handlers.concurrency ?? 1 },
      );

      for (const { id, outcome } of settled) {
        outcomes.set(id, outcome);
        pending.delete(id);
      }
    }

    return { _tag: "Settled", outcomes };
  });
