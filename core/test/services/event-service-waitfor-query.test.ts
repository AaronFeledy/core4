import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Fiber, Layer, Stream, TestClock, TestContext } from "effect";

import { EventService, SecretStore } from "@lando/sdk/services";

import { RedactionServiceLive } from "../../src/redaction/service.ts";
import { EventServiceLive, makeEventServiceLive } from "../../src/services/event-service.ts";

const progressEvent = (bytes: number): { readonly _tag: "download-progress"; readonly bytes: number } => ({
  _tag: "download-progress",
  bytes,
});

const secretEvent = (token: string) => ({
  _tag: "pre-download",
  url: `https://user:${token}@example.com/asset`,
  note: `token is ${token}`,
});

const secretStoreLayer = (values: ReadonlyArray<string>) =>
  Layer.succeed(SecretStore, {
    id: "test-secret-store",
    list: Effect.succeed([...values.keys()].map((index) => `secret-${index}`)),
    has: (id: string) => Effect.succeed(values[Number.parseInt(id.replace("secret-", ""), 10)] !== undefined),
    get: (id: string) => {
      const index = Number.parseInt(id.replace("secret-", ""), 10);
      const value = values[index];
      return value === undefined ? Effect.fail(new Error("missing") as never) : Effect.succeed(value);
    },
  } as never);

describe("EventService waitFor", () => {
  test("resolves the first matching event from the live stream", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const waiter = yield* events
            .waitFor("download-progress", { filter: (event) => event.bytes >= 2 })
            .pipe(Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* events.publish(progressEvent(1));
          yield* events.publish(progressEvent(2));
          return yield* Fiber.join(waiter);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(received).toEqual(progressEvent(2));
  });

  test("times out via Clock with EventError reason 'timeout'", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const waiter = yield* events
            .waitFor("download-progress", { timeout: "1 second" })
            .pipe(Effect.exit, Effect.fork);
          yield* TestClock.adjust("2 seconds");
          return yield* Fiber.join(waiter);
        }),
      ).pipe(Effect.provide(EventServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        expect(error.value._tag).toBe("EventError");
        expect(error.value.reason).toBe("timeout");
      }
    }
  });

  test("without a timeout it does not resolve before a matching event", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const waiter = yield* events.waitFor("download-progress").pipe(Effect.fork);
          yield* TestClock.adjust("1 hour");
          const poll = yield* Fiber.poll(waiter);
          yield* Fiber.interrupt(waiter);
          return poll;
        }),
      ).pipe(Effect.provide(EventServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(exit._tag).toBe("None");
  });
});

describe("EventService waitForAny", () => {
  test("resolves with the first event matching any spec", async () => {
    const received = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const waiter = yield* events
            .waitForAny([{ name: "pre-download" }, { name: "download-progress" }])
            .pipe(Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* events.publish(progressEvent(7));
          return yield* Fiber.join(waiter);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(received).toEqual(progressEvent(7));
  });

  test("honors the timeout contract", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const waiter = yield* events
            .waitForAny([{ name: "pre-download" }], { timeout: "1 second" })
            .pipe(Effect.exit, Effect.fork);
          yield* TestClock.adjust("2 seconds");
          return yield* Fiber.join(waiter);
        }),
      ).pipe(Effect.provide(EventServiceLive), Effect.provide(TestContext.TestContext)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("EventService history buffer and query", () => {
  test("query scans buffered events without blocking", async () => {
    const found = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          yield* events.publish(progressEvent(1));
          yield* events.publish(progressEvent(2));
          yield* events.publish(progressEvent(3));
          return yield* events.query("download-progress", (event) => event.bytes >= 2);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(found.map((event) => event.bytes)).toEqual([2, 3]);
  });

  test("evicts oldest-first once the cap is exceeded", async () => {
    const found = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          for (let index = 0; index < 5; index += 1) {
            yield* events.publish(progressEvent(index));
          }
          return yield* events.query("*");
        }),
      ).pipe(Effect.provide(makeEventServiceLive(3))),
    );

    expect(found.map((event) => (event as { bytes: number }).bytes)).toEqual([2, 3, 4]);
  });

  test("redacts payloads before buffering so query never observes a raw secret", async () => {
    const token = "s3cr3t-token-abc123";
    const redaction = RedactionServiceLive.pipe(Layer.provide(secretStoreLayer([token])));
    const eventLayer = makeEventServiceLive(8).pipe(Layer.provide(redaction));

    const snapshot = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          yield* events.publish(secretEvent(token));
          return yield* events.query("*");
        }),
      ).pipe(Effect.provide(eventLayer)),
    );

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[redacted]");
  });

  test("refreshes redaction at append time for secrets store and env auth values", async () => {
    const token = "late-env-auth-token-xyz789";
    const envKey = "BUN_AUTH_TOKEN";
    const previous = process.env[envKey];
    delete process.env[envKey];
    try {
      const redaction = RedactionServiceLive.pipe(Layer.provide(secretStoreLayer([])));
      const eventLayer = makeEventServiceLive(8).pipe(Layer.provide(redaction));
      process.env[envKey] = token;

      const snapshot = await Effect.runPromise(
        Effect.flatMap(EventService, (events) =>
          Effect.gen(function* () {
            yield* events.publish(secretEvent(token));
            return yield* events.query("*");
          }),
        ).pipe(Effect.provide(eventLayer)),
      );

      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(token);
      expect(serialized).toContain("[redacted]");
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  });

  test("redacts history with the standalone fallback when RedactionService is absent", async () => {
    const token = "fallback-auth-token-us-318";
    const envKey = "BUN_AUTH_TOKEN";
    const previous = process.env[envKey];
    process.env[envKey] = token;

    try {
      const snapshot = await Effect.runPromise(
        Effect.flatMap(EventService, (events) =>
          Effect.gen(function* () {
            yield* events.publish(secretEvent(token));
            return yield* events.query("*");
          }),
        ).pipe(Effect.provide(makeEventServiceLive(8))),
      );

      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(token);
      expect(serialized).toContain("[redacted]");
      expect(serialized).toContain("example.com/asset");
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  });

  test("cap of 0 is a zero-allocation no-op: query returns the same empty array", async () => {
    const { first, second } = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          yield* events.publish(progressEvent(1));
          yield* events.publish(progressEvent(2));
          const first = yield* events.query("*");
          const second = yield* events.query("download-progress");
          return { first, second };
        }),
      ).pipe(Effect.provide(makeEventServiceLive(0))),
    );

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(first).toBe(second);
  });
});

describe("EventService regression", () => {
  test("publish with zero subscribers still records history and does not fail", async () => {
    const count = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          yield* events.publish(progressEvent(1));
          yield* events.publish(progressEvent(2));
          const recorded = yield* events.query("*");
          return recorded.length;
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(count).toBe(2);
  });

  test("subscribe completes when the surrounding scope closes", async () => {
    const exit = await Effect.runPromise(
      Effect.flatMap(EventService, (events) =>
        Effect.gen(function* () {
          const scopedFiber = yield* Effect.scoped(
            events.subscribe("download-progress").pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped),
          );
          yield* events.publish(progressEvent(1));
          return yield* Fiber.await(scopedFiber);
        }),
      ).pipe(Effect.provide(EventServiceLive)),
    );

    expect(Exit.isInterrupted(exit)).toBe(true);
  });
});
