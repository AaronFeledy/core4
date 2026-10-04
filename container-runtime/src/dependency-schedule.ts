import { Effect, Graph } from "effect";

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

export const runDependencySchedule = Effect.fnUntraced(function* <A, E, R>(
  graph: ScheduleGraph<A>,
  handlers: ScheduleHandlers<A, E, R>,
): Effect.fn.Return<ScheduleResult, E, R> {
  const nodes = new Map<string, ScheduleNode<A>>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }

  const edges = graph.edges.filter(
    ({ predecessor, dependent }) => nodes.has(predecessor) && nodes.has(dependent),
  );
  const outcomes = new Map<string, ScheduleOutcome>();
  const nodeIndices = new Map<string, Graph.NodeIndex>();
  const pending = Graph.beginMutation(
    Graph.directed<ScheduleNode<A>, ScheduleEdge>((mutable) => {
      for (const node of nodes.values()) nodeIndices.set(node.id, Graph.addNode(mutable, node));
      for (const edge of edges) {
        const predecessor = nodeIndices.get(edge.predecessor);
        const dependent = nodeIndices.get(edge.dependent);
        if (predecessor !== undefined && dependent !== undefined) {
          Graph.addEdge(mutable, predecessor, dependent, edge);
        }
      }
    }),
  );

  while (Graph.nodeCount(pending) > 0) {
    const ready = [...Graph.entries(Graph.nodes(pending))]
      .filter(([index]) => Graph.inDegree(pending, index) === 0)
      .map(([, node]) => node)
      .sort((left, right) => left.id.localeCompare(right.id));

    if (ready.length === 0 && !Graph.isAcyclic(pending)) {
      return {
        _tag: "Cycle",
        edges: [...Graph.values(Graph.edges(pending))]
          .map((edge) => edge.data)
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
      const index = nodeIndices.get(id);
      if (index !== undefined) Graph.removeNode(pending, index);
    }
  }

  return { _tag: "Settled", outcomes };
});
