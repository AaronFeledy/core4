import { Graph } from "effect";

export const hasIncludeCycle = (ancestors: ReadonlyArray<string>, source: string): boolean => {
  const graph = Graph.directed<string, undefined>((mutable) => {
    const indices = new Map<string, Graph.NodeIndex>();
    let predecessor: Graph.NodeIndex | undefined;
    for (const identity of [...ancestors, source]) {
      const index = indices.get(identity) ?? Graph.addNode(mutable, identity);
      indices.set(identity, index);
      if (predecessor !== undefined) Graph.addEdge(mutable, predecessor, index, undefined);
      predecessor = index;
    }
  });
  return !Graph.isAcyclic(graph);
};
