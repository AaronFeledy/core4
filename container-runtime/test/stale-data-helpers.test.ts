import { expect, test } from "bun:test";
import { Effect, Fiber, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { isStaleDataHelper, sweepStaleDataHelpers } from "../src/stale-data-helpers.ts";
import {
  NOW,
  freshTime,
  helperEngine,
  helperLabels,
  redactor,
  staleHelper,
  staleTime,
} from "./support/stale-helper-engine.ts";

const spec = { image: "alpine:3.20", command: ["true"], remove: true } as const;

test("sweep removes only old stopped helpers of this provider", async () => {
  const engine = helperEngine([
    staleHelper("stale"),
    { ...staleHelper("dead"), state: "dead" },
    { id: "never-started", state: "created", labels: helperLabels(), created: staleTime },
    {
      id: "never-started-dead",
      state: "dead",
      labels: helperLabels(),
      created: staleTime,
      startedAt: "0001-01-01T00:00:00Z",
    },
    { ...staleHelper("fresh"), finishedAt: freshTime },
    { ...staleHelper("running"), state: "running" },
    { ...staleHelper("inconsistent"), running: true },
    { ...staleHelper("foreign"), labels: helperLabels("other") },
    { ...staleHelper("service"), labels: { ...helperLabels(), "dev.lando.role": "service" } },
    { id: "unknown-finish", state: "exited", labels: helperLabels(), created: staleTime },
  ]);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* sweepStaleDataHelpers(engine.api.request, { providerId: "test", redactor });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect([...engine.containers.keys()]).toEqual([
    "fresh",
    "running",
    "inconsistent",
    "foreign",
    "service",
    "unknown-finish",
  ]);
  expect(engine.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
    "/containers/stale?force=true&v=true",
    "/containers/dead?force=true&v=true",
    "/containers/never-started?force=true&v=true",
    "/containers/never-started-dead?force=true&v=true",
  ]);
  const filters = new URL(`http://engine${engine.calls[0]?.path}`).searchParams;
  expect(filters.get("all")).toBe("true");
  expect(JSON.parse(filters.get("filters") ?? "{}")).toEqual({
    label: ["dev.lando.role=data-helper", "dev.lando.provider=test"],
  });
});

test.each([
  ["strict age threshold", "exited", new Date(NOW - 600_000).toISOString()],
  ["invalid timestamp", "exited", "invalid"],
  ["zero finish time", "exited", "0001-01-01T00:00:00Z"],
  ["paused container", "paused", staleTime],
] as const)("preserves a helper with %s", (_name, state, finishedAt) => {
  expect(
    isStaleDataHelper({
      labels: helperLabels(),
      providerId: "test",
      state,
      finishedAt,
      created: staleTime,
      nowMs: NOW,
    }),
  ).toBe(false);
});

test("sweep runs once per data-plane instance even with reused options and unexecuted runs", async () => {
  const engine = helperEngine([]);
  const options = {
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: engine.api,
  } as const;
  const first = makeProviderDataPlane(options);
  const abandoned = first.run(spec);
  const second = makeProviderDataPlane(options);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(first.run(spec));
      yield* Effect.scoped(abandoned);
      yield* Effect.scoped(second.run(spec));
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(engine.calls.filter((call) => call.path.startsWith("/containers/json?"))).toHaveLength(2);
  expect(engine.calls.filter((call) => call.path.startsWith("/containers/create?"))).toHaveLength(3);
  expect(engine.calls[0]?.path.startsWith("/containers/json?")).toBe(true);
});

test.each(["request", "http", "inspect", "remove"] as const)(
  "a %s failure logs redacted diagnostics and allows the run",
  async (stage) => {
    const engine = helperEngine([staleHelper("stale")]);
    const logs: string[] = [];
    const options = {
      providerId: "test",
      capabilities: { volumeSnapshot: "none" },
      redactor,
      api: {
        ...engine.api,
        request: (input: Parameters<typeof engine.api.request>[0]) => {
          if (input.path.startsWith("/containers/json?")) {
            if (stage === "request") return Effect.die("SENSITIVE transport failure");
            if (stage === "http") return Effect.succeed({ status: 500, body: "SENSITIVE failure" });
          }
          if (stage === "inspect" && input.path === "/containers/stale/json") {
            return Effect.succeed({ status: 200, body: "invalid SENSITIVE response" });
          }
          if (stage === "remove" && input.path === "/containers/stale?force=true&v=true") {
            return Effect.succeed({ status: 500, body: "SENSITIVE failure" });
          }
          return engine.api.request(input);
        },
      },
    } as const;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        return yield* Effect.scoped(makeProviderDataPlane(options).run(spec));
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(
          Logger.layer([
            Logger.make((event) => {
              logs.push(Logger.formatJson.log(event));
            }),
          ]),
        ),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("SENSITIVE");
    if (stage !== "inspect") expect(logs[0]).toContain("[REDACTED]");
  },
);

test("a never-ending sweep releases the user's run at its five-second deadline", async () => {
  const engine = helperEngine([]);
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: {
      ...engine.api,
      request: (input) =>
        input.path.startsWith("/containers/json?") ? Effect.never : engine.api.request(input),
    },
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fiber = yield* Effect.forkChild(Effect.scoped(plane.run(spec)));
      yield* TestClock.adjust("5 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.exitCode).toBe(0);
  expect(engine.calls.filter((call) => call.path.startsWith("/containers/create?"))).toHaveLength(1);
});
