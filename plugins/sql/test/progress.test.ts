import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { publishTree } from "../src/progress.ts";
import type { DbCommandStep } from "../src/schemas.ts";

type Published = {
  readonly _tag: string;
  readonly durationMs?: number;
};

const collectPublisher = () => {
  const events: Published[] = [];
  return {
    events,
    publish: (event: { readonly _tag: string; readonly [key: string]: unknown }) =>
      Effect.sync(() => {
        events.push({
          _tag: event._tag,
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        });
      }),
  };
};

const steps: ReadonlyArray<DbCommandStep> = [
  { id: "export", label: "export database", target: "database", destructive: false },
  { id: "verify", label: "verify database", target: "database", destructive: false },
];

describe("sql progress publisher", () => {
  test("starts every declared child before completing any child", async () => {
    const publisher = collectPublisher();

    await Effect.runPromise(
      Effect.gen(function* () {
        const progress = yield* publishTree(publisher.publish, "db:export", steps);
        yield* progress.complete;
      }),
    );

    const tags = publisher.events.map((event) => event._tag);
    const lastStart = tags.lastIndexOf("task.start");
    const firstComplete = tags.indexOf("task.complete");
    expect(lastStart).toBeGreaterThan(-1);
    expect(firstComplete).toBeGreaterThan(lastStart);
    expect(tags.filter((tag) => tag === "task.start")).toHaveLength(steps.length);
    expect(tags.filter((tag) => tag === "task.complete")).toHaveLength(steps.length);
    expect(tags[0]).toBe("task.tree.start");
    expect(tags[tags.length - 1]).toBe("task.tree.complete");
  });

  test("complete events carry durationMs after the shared start-all window", async () => {
    const publisher = collectPublisher();

    await Effect.runPromise(
      Effect.gen(function* () {
        const progress = yield* publishTree(publisher.publish, "db:export", steps);
        yield* progress.complete;
      }),
    );

    const completed = publisher.events.filter((event) => event._tag === "task.complete");
    expect(completed).toHaveLength(steps.length);
    for (const event of completed) {
      if (event._tag !== "task.complete") continue;
      expect(typeof event.durationMs).toBe("number");
    }
  });
});
