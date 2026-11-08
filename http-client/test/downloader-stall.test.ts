import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import { OnlineAcquisition } from "@lando/sdk/services";
import type { LandoEvent } from "@lando/sdk/services";
import { CurrentTaskDetail, makeTaskTree, withCurrentTaskDetail } from "@lando/sdk/task-progress";
import { makeDownloaderService } from "../src/downloader-service.ts";

const payload = new TextEncoder().encode("chunk");

const harness = Effect.gen(function* () {
  const opened = yield* Queue.unbounded<number>();
  const retries = yield* Queue.unbounded<void>();
  const progress = yield* Queue.unbounded<void>();
  const events: LandoEvent[] = [];
  let calls = 0;
  let released = 0;
  const make = (first: "headers" | "body" | "steady") =>
    makeDownloaderService(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          calls += 1;
          const attempt = calls;
          const scope = yield* Effect.serviceOption(Scope.Scope);
          if (Option.isSome(scope))
            yield* Scope.addFinalizer(
              scope.value,
              Effect.sync(() => {
                released += 1;
              }),
            );
          yield* Queue.offer(opened, attempt);
          if (first === "headers" && attempt === 1) return yield* Effect.never;
          const body =
            first === "steady"
              ? Stream.fromIterable([1, 2, 3, 4]).pipe(
                  Stream.mapEffect(() => Effect.sleep("40 seconds").pipe(Effect.as(payload))),
                )
              : first === "body" && attempt === 1
                ? Stream.concat(Stream.make(payload), Stream.never)
                : Stream.make(payload);
          const response = HttpClientResponse.fromWeb(request, new Response());
          return new Proxy(response, {
            get: (target, key, receiver) => (key === "stream" ? body : Reflect.get(target, key, receiver)),
          });
        }),
      ),
      {
        redactText: (text) => text.replaceAll("secret-name", "[redacted]"),
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event._tag === "message.warn"
                ? Queue.offer(retries, undefined)
                : event._tag === "download-progress"
                  ? Queue.offer(progress, undefined)
                  : Effect.void,
            ),
            Effect.asVoid,
          ),
      },
    );
  return { make, opened, retries, progress, events, calls: () => calls, released: () => released };
});

for (const stall of ["headers", "body"] as const) {
  test(`${stall} stall times out, releases the attempt, and retries under acquisition intent`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const h = yield* harness;
        const downloader = h.make(stall);
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            downloader.download({ url: "https://test.invalid/file", destination: { kind: "memory" } }),
          ).pipe(Effect.provideService(OnlineAcquisition, true)),
        );
        yield* Queue.take(h.opened);
        if (stall === "body") yield* Queue.take(h.progress);
        yield* TestClock.adjust(stall === "headers" ? "119 seconds" : "59 seconds");
        expect(h.events.filter((event) => event._tag === "message.warn")).toEqual([]);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(h.retries);
        expect(h.released()).toBe(1);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result.sizeBytes).toBe(payload.length);
        expect(h.calls()).toBe(2);
        expect(h.events.filter((event) => event._tag === "post-download")).toMatchObject([
          { outcome: "success", attempts: 2 },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ));
}

test("a routine header stall fails once after 120 seconds", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* harness;
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          h.make("headers").download({ url: "https://test.invalid/file", destination: { kind: "memory" } }),
        ),
      );
      yield* Queue.take(h.opened);
      yield* TestClock.adjust("120 seconds");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "DownloadFetchError",
          reason: "timeout",
          attempts: 1,
        });
      expect(h.calls()).toBe(1);
      expect(h.released()).toBe(1);
      expect(h.events.filter((event) => event._tag === "post-download")).toMatchObject([
        { failureDetail: "fetch-failed reason=timeout", attempts: 1 },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("slow steady bytes reset the idle budget on each pull", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* harness;
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          h.make("steady").download({ url: "https://test.invalid/file", destination: { kind: "memory" } }),
        ),
      );
      yield* Queue.take(h.opened);
      for (let chunk = 0; chunk < 4; chunk += 1) {
        yield* TestClock.adjust("40 seconds");
        yield* Queue.take(h.progress);
      }
      expect((yield* Fiber.join(fiber)).sizeBytes).toBe(payload.length * 4);
      expect(h.calls()).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("file sources have no header deadline", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* harness;
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          h
            .make("headers")
            .download({ url: "file:///tmp/file", allowFileSource: true, destination: { kind: "memory" } }),
        ),
      );
      yield* Queue.take(h.opened);
      yield* TestClock.adjust("121 seconds");
      expect(h.released()).toBe(0);
      expect(h.events.filter((event) => event._tag === "post-download")).toEqual([]);
      yield* Fiber.interrupt(fiber);
      expect(h.released()).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a retry inside a task emits redacted task detail instead of a warning", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* harness;
      const details = yield* Queue.unbounded<void>();
      const events: LandoEvent[] = [];
      const tree = makeTaskTree(
        {
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(
              Effect.andThen(event._tag === "task.detail" ? Queue.offer(details, undefined) : Effect.void),
              Effect.asVoid,
            ),
        },
        {
          parentId: "setup",
          label: "Setup",
          children: [{ id: "download", label: "Download" }],
        },
      );
      yield* tree.start;
      yield* tree.startTask("download");
      const body = Effect.scoped(
        h.make("headers").download({
          url: "https://test.invalid/file",
          destination: { kind: "file", directory: "/unused", filename: "secret-name" },
        }),
      );
      const fiber = yield* Effect.forkChild(
        withCurrentTaskDetail(tree, "download", body).pipe(Effect.provideService(OnlineAcquisition, true)),
      );
      yield* Queue.take(h.opened);
      yield* TestClock.adjust("120 seconds");
      yield* Queue.take(details);
      expect(events.filter((event) => event._tag === "task.detail")).toMatchObject([
        {
          taskId: "download",
          stream: "stderr",
          line: "Retrying [redacted] from https://test.invalid (attempt 2 of 3): the download timed out.",
        },
      ]);
      expect(h.events.filter((event) => event._tag === "message.warn")).toEqual([]);
      yield* Fiber.interrupt(fiber);
      expect(yield* CurrentTaskDetail).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  ));
