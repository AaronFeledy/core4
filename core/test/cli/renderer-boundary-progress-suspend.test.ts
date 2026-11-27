import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { TaskTreeStartEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";
import { Context, Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import { SuspendCommandProgress, suspendCommandProgress } from "../../src/cli/command-progress";
import { startCommandProgressConsumer } from "../../src/cli/command-progress-handoff";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { makeInteractionService } from "../../src/interaction/service";

const timestamp = "2026-11-25T00:00:00.000Z";
const publish = (body: string) =>
  Effect.flatMap(EventService, (events) => events.publish({ _tag: "message.info", body, timestamp }));
const openTree = Effect.flatMap(EventService, (events) =>
  events.publish({ _tag: "task.tree.start", parentId: "setup", label: "Setup", children: [], timestamp }),
);

const runPlain = (command: Effect.Effect<unknown, unknown, EventService>) => {
  const io = createBufferedRendererIO({ isTTY: false });
  const run = runWithRendererHandling(Effect.as(command, {}), {
    runtime: LandoEventService.layer,
    io,
    rendererMode: "plain",
    resultFormat: "text",
    resultSchema: Schema.Struct({}),
    command: "test:progress-suspend",
    render: () => "",
    formatError: ({ error }) => String(error),
    setExitCode: () => undefined,
    deprecationWarnings: false,
  });
  return { io, run };
};

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("command progress handoff", () => {
  test("resumes the renderer with the invocation's services rather than the prompt caller's", async () => {
    const Source = Context.Reference("test/ProgressServiceSource", { defaultValue: () => "fallback" });
    const rendererSources: string[] = [];
    const render = Layer.effectDiscard(
      Effect.map(Source, (source) => {
        rendererSources.push(source);
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const progress = yield* startCommandProgressConsumer(render);
          yield* progress.suspension.suspend(Effect.void).pipe(Effect.provideService(Source, "prompt"));
        }),
      ).pipe(Effect.provide(LandoEventService.layer), Effect.provideService(Source, "invocation")),
    );

    expect(rendererSources).toEqual(["invocation", "invocation"]);
  });

  test("a committed event survives resuming progress while publication callbacks are still running", async () => {
    const received: unknown[] = [];
    const consumerLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const queue = yield* (yield* EventService).subscribeQueue;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const event of yield* Queue.clear(queue)) {
              if (event._tag === "message.info") received.push(event.body);
            }
          }),
        );
      }),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const progress = yield* startCommandProgressConsumer(consumerLayer);
          const committed = yield* Deferred.make<void>();
          const releaseObserver = yield* Deferred.make<void>();
          const publisher = yield* progress.suspension.suspend(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkScoped(
                publish("while lending the terminal").pipe(
                  Effect.provideService(LandoEventService.EventCommitObserver, progress.observe),
                  Effect.provideService(LandoEventService.EventPublicationObserver, () =>
                    Deferred.succeed(committed, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseObserver)),
                    ),
                  ),
                ),
              );
              yield* Deferred.await(committed);
              return fiber;
            }),
          );
          yield* Deferred.succeed(releaseObserver, undefined);
          yield* Fiber.join(publisher);
          yield* progress.finish;
        }),
      ).pipe(Effect.provide(LandoEventService.layer), Effect.timeout("5 seconds")),
    );

    expect(received).toEqual(["while lending the terminal"]);
  });

  test("lends the terminal with everything earlier on screen, then renders later events once, in order", async () => {
    // Given a command that publishes around a handoff while another fiber publishes during it.
    const screens: { atStart?: string; atEnd?: string } = {};
    const { io, run } = runPlain(
      Effect.gen(function* () {
        yield* publish("before the prompt");
        yield* suspendCommandProgress(
          Effect.gen(function* () {
            screens.atStart = io.stderr();
            const concurrent = yield* Effect.forkChild(publish("published while sudo prompts"));
            yield* Fiber.join(concurrent);
            yield* Effect.yieldNow;
            screens.atEnd = io.stderr();
          }),
        );
        yield* publish("after the prompt");
      }),
    );

    // When
    await run;

    // Then nothing was drawn while the terminal was lent out, and nothing was lost or repeated.
    expect(screens.atStart).toContain("before the prompt");
    expect(screens.atEnd).toBe(screens.atStart);
    const output = io.stderr();
    for (const line of ["before the prompt", "published while sudo prompts", "after the prompt"]) {
      expect(occurrences(output, line)).toBe(1);
    }
    expect(output.indexOf("published while sudo prompts")).toBeGreaterThan(
      output.indexOf("before the prompt"),
    );
    expect(output.indexOf("after the prompt")).toBeGreaterThan(
      output.indexOf("published while sudo prompts"),
    );
  });

  test("replays every event published while the terminal is lent out, more than a subscription holds", async () => {
    // Given far more events published during the prompt than one live subscription has room for.
    const lines = Array.from({ length: 300 }, (_, index) => `published during the prompt ${index}`);
    const { io, run } = runPlain(
      suspendCommandProgress(
        Effect.gen(function* () {
          const concurrent = yield* Effect.forkChild(Effect.forEach(lines, publish, { discard: true }));
          yield* Fiber.join(concurrent);
        }),
      ),
    );

    // When
    await run;

    // Then each one renders once, in order, after the prompt.
    const output = io.stderr();
    for (const line of lines) expect(occurrences(output, `${line}\n`)).toBe(1);
    expect(output.indexOf(lines[299] ?? "")).toBeGreaterThan(output.indexOf(lines[0] ?? ""));
  });

  test("a handoff inside an open task tree retires progress for the rest of the run", async () => {
    // Given a tree that is still open when the terminal is lent out.
    const screens: { atStart?: string } = {};
    const { io, run } = runPlain(
      Effect.gen(function* () {
        yield* openTree;
        yield* publish("inside the tree");
        yield* suspendCommandProgress(
          Effect.sync(() => {
            screens.atStart = io.stderr();
          }),
        );
        yield* publish("after the prompt");
      }),
    );

    // When
    await run;

    // Then the earlier events rendered before the prompt, and progress stays retired after it.
    expect(screens.atStart).toContain("inside the tree");
    expect(io.stderr()).not.toContain("after the prompt");
  });

  test("a handoff inside another lends the terminal once and rebuilds progress once", async () => {
    // Given a consumer whose builds are counted.
    let builds = 0;
    const counted = Layer.effectDiscard(
      Effect.sync(() => {
        builds += 1;
      }),
    );

    // When a handoff runs inside another.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const consumer = yield* startCommandProgressConsumer(counted);
          yield* consumer.suspension.suspend(consumer.suspension.suspend(Effect.void));
        }),
      ).pipe(Effect.provide(LandoEventService.layer)),
    );

    // Then progress was built once at start and once after the outer handoff.
    expect(builds).toBe(2);
  });
});

/**
 * A terminal whose live task tree holds raw mode while it is drawn, as the lando renderer's does:
 * while raw, typed keys go to the tree, not to a line reader.
 */
const rawModeTerminal = () => {
  const events: string[] = [];
  let raw = false;
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const type = (text: string) => {
    if (raw) events.push(`tree swallowed ${JSON.stringify(text)}`);
    else stdin.write(text);
  };
  const stderr = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        if (String(chunk).includes("Approve these changes?")) {
          events.push(raw ? "question drawn under raw mode" : "question drawn");
          queueMicrotask(() => type("y\n"));
        }
        callback();
      },
    }),
    { isTTY: true },
  );
  const liveTree = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        raw = true;
        events.push("tree holds raw mode");
      }),
      () =>
        Effect.sync(() => {
          raw = false;
          events.push("tree released raw mode");
        }),
    ),
  );
  return { events, stdin, stderr, liveTree };
};

describe("prompts during live progress", () => {
  test("a question asked inside an open task tree gets the terminal and reads what the user types", async () => {
    // Given an open task tree holding the terminal in raw mode.
    const terminal = rawModeTerminal();
    const service = makeInteractionService({ stdin: terminal.stdin, stderr: terminal.stderr });

    // When a line-mode question is asked inside it.
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const consumer = yield* startCommandProgressConsumer(terminal.liveTree);
          consumer.observe(
            Schema.decodeUnknownSync(TaskTreeStartEvent)({
              _tag: "task.tree.start",
              parentId: "doctor",
              label: "doctor",
              children: [],
              timestamp,
            }),
          );
          return yield* service
            .confirm({ name: "approve", message: "Approve these changes?", mode: "interactive" })
            .pipe(Effect.provideService(SuspendCommandProgress, consumer.suspension));
        }),
      ).pipe(Effect.provide(LandoEventService.layer), Effect.timeout("5 seconds")),
    );

    // Then the tree let go of the terminal before the question, and the typed answer arrived.
    expect(answer).toBe(true);
    expect(terminal.events).toEqual(["tree holds raw mode", "tree released raw mode", "question drawn"]);
  });

  test("a question answered by flags leaves live progress alone", async () => {
    // Given an open task tree holding the terminal.
    const terminal = rawModeTerminal();
    const service = makeInteractionService({ stdin: terminal.stdin, stderr: terminal.stderr });

    // When the question is answered without reading the terminal.
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const consumer = yield* startCommandProgressConsumer(terminal.liveTree);
          return yield* service
            .confirm({ name: "approve", message: "Approve these changes?", yes: true, default: true })
            .pipe(Effect.provideService(SuspendCommandProgress, consumer.suspension));
        }),
      ).pipe(Effect.provide(LandoEventService.layer)),
    );

    // Then the tree kept the terminal until the command ended.
    expect(answer).toBe(true);
    expect(terminal.events).toEqual(["tree holds raw mode", "tree released raw mode"]);
  });
});
