import { expect, test } from "bun:test";
import { Effect } from "effect";

import { runDependencySchedule } from "../src/dependency-schedule.ts";

test("settles independent nodes before reporting a cycle and its blocked tail", async () => {
  // Given
  const calls: string[] = [];
  const graph = {
    nodes: ["independent", "a", "b", "tail"].map((id) => ({ id, value: id })),
    edges: [
      { predecessor: "a", dependent: "b", required: true },
      { predecessor: "b", dependent: "a", required: false },
      { predecessor: "b", dependent: "tail", required: true },
      { predecessor: "independent", dependent: "tail", required: true },
    ],
  };

  // When
  const result = await Effect.runPromise(
    runDependencySchedule(graph, {
      run: (node) =>
        Effect.sync(() => {
          calls.push(node.id);
          return "succeeded" as const;
        }),
    }),
  );

  // Then
  expect({ calls, result }).toEqual({
    calls: ["independent"],
    result: { _tag: "Cycle", edges: ["b -> a", "a -> b", "tail -> b"] },
  });
});
