/**
 * Default TTY consumer wiring — split-footer live region vs line-mode degradation.
 *
 * These host tests drive the event consumer against a recording fake live-region
 * controller (no native OpenTUI binding). They prove the routing/ordering, the
 * tree-complete scrollback commit, dispose-on-scope-close, and the two
 * degradation fallbacks. Native split-footer behavior (AC3 resize replay, AC4
 * alt-screen) is validated in the Wave 5 sandbox headless suite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, LogLevel, Logger, Queue, Schema } from "effect";

import {
  type LandoEvent,
  MessageWarnEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { RendererIO } from "@lando/sdk/renderer";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PathsService, Renderer } from "@lando/sdk/services";

import { createBufferedRendererIO } from "../../../core/src/cli/renderer/io.ts";
import { makeLandoPaths } from "../../../core/src/config/paths.ts";
import { EventServiceLive } from "../../../core/src/services/event-service.ts";
import type { LiveRegionControllerOptions } from "../src/opentui/live-region-controller.ts";
import { resetOpenTuiSubstrateAvailabilityForTests } from "../src/opentui/substrate-availability.ts";
import { makeLandoEventConsumer } from "../src/renderer-runtime.ts";
import { makeLandoService } from "../src/renderer-service.ts";

type TranscriptTailPageDirection = "latest" | "older" | "newer" | "refresh";
interface TranscriptTailReaderShape {
  readonly open: (
    path: typeof AbsolutePath.Type,
    onChange: Effect.Effect<void>,
  ) => Effect.Effect<
    {
      readonly read: (
        direction: TranscriptTailPageDirection,
        lineLimit: number,
      ) => Effect.Effect<{ readonly lines: ReadonlyArray<string> }>;
    },
    never,
    import("effect").Scope.Scope
  >;
}

const ts = "2026-05-19T12:00:00.000Z";

const treeStart = (children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId: "build",
    label: "Building",
    children,
    timestamp: ts,
  });
const taskStart = (taskId: string, transcriptPath?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    label: taskId,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    timestamp: ts,
  });
const taskComplete = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary: `${taskId} ready`,
    durationMs: 10,
    timestamp: ts,
  });
const taskDetail = (taskId: string, line: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    stream: "stdout",
    line,
    timestamp: ts,
  });
const treeComplete = (): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "build",
    summary: "done",
    succeeded: 1,
    failed: 0,
    timestamp: ts,
  });
const warn = (body: string): LandoEvent =>
  Schema.decodeUnknownSync(MessageWarnEvent)({ _tag: "message.warn", body, timestamp: ts });

type ControllerCall =
  | { readonly kind: "setFooter"; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "commitScrollback"; readonly text: string }
  | { readonly kind: "rememberScrollback"; readonly text: string }
  | { readonly kind: "requestLive" }
  | { readonly kind: "dropLive" }
  | { readonly kind: "enterFullTail" }
  | { readonly kind: "exitFullTail" }
  | { readonly kind: "dispose" };

class FakeController {
  readonly calls: ControllerCall[] = [];
  setFooter(lines: ReadonlyArray<string>): void {
    this.calls.push({ kind: "setFooter", lines: [...lines] });
  }
  commitScrollback(text: string): void {
    this.calls.push({ kind: "commitScrollback", text });
  }
  rememberScrollback(text: string): void {
    this.calls.push({ kind: "rememberScrollback", text });
  }
  requestLive(): void {
    this.calls.push({ kind: "requestLive" });
  }
  dropLive(): void {
    this.calls.push({ kind: "dropLive" });
  }
  resize(): void {}
  enterFullTail(): void {
    this.calls.push({ kind: "enterFullTail" });
  }
  exitFullTail(): void {
    this.calls.push({ kind: "exitFullTail" });
  }
  reset(): void {}
  dispose(): void {
    this.calls.push({ kind: "dispose" });
  }
}

class FakeTranscriptReader implements TranscriptTailReaderShape {
  readonly opened: string[] = [];
  readonly closed: string[] = [];
  readonly reads: Array<{ readonly direction: TranscriptTailPageDirection; readonly lineLimit: number }> = [];
  readonly #lines = new Map<string, string[]>();
  readonly #changes = new Map<string, Effect.Effect<void>>();
  #lastChange: Effect.Effect<void> = Effect.void;

  set(path: string, lines: ReadonlyArray<string>): void {
    this.#lines.set(path, [...lines]);
  }

  append(path: string, line: string): Effect.Effect<void> {
    this.#lines.get(path)?.push(line);
    return this.#changes.get(path) ?? Effect.void;
  }

  fireLateChange(): Effect.Effect<void> {
    return this.#lastChange;
  }

  open(path: typeof AbsolutePath.Type, onChange: Effect.Effect<void>) {
    return Effect.acquireRelease(
      Effect.sync(() => {
        this.opened.push(path);
        this.#changes.set(path, onChange);
        this.#lastChange = onChange;
        let end = this.#lines.get(path)?.length ?? 0;
        let knownLength = end;
        return {
          read: (direction: TranscriptTailPageDirection, lineLimit: number) =>
            Effect.sync(() => {
              this.reads.push({ direction, lineLimit });
              const lines = this.#lines.get(path) ?? [];
              if (direction === "latest" || (direction === "refresh" && end === knownLength)) {
                end = lines.length;
              } else if (direction === "older") {
                end = Math.max(lineLimit, end - lineLimit);
              } else if (direction === "newer") {
                end = Math.min(lines.length, end + lineLimit);
              }
              knownLength = lines.length;
              return { lines: lines.slice(Math.max(0, end - lineLimit), end) };
            }),
        };
      }),
      () =>
        Effect.sync(() => {
          this.closed.push(path);
          this.#changes.delete(path);
        }),
    );
  }
}

const ttyIo = () => {
  const stdout: string[] = [];
  const io = createBufferedRendererIO({ isTTY: true, terminalColumns: 80, terminalRows: 24 });
  const streamStub = process.stdout;
  return {
    io: { ...io, externalOutputStream: streamStub, writeStdout: (chunk: string) => stdout.push(chunk) },
    stdout: () => stdout.join(""),
  };
};

const drive = (
  io: RendererIO,
  createLiveRegion: (options: LiveRegionControllerOptions) => Promise<FakeController>,
  events: ReadonlyArray<LandoEvent>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of events) yield* svc.publish(event);
      yield* Effect.sleep("20 millis");
    }).pipe(
      Effect.provide(Layer.provideMerge(makeLandoEventConsumer(io, { createLiveRegion }), EventServiceLive)),
    ),
  );

afterEach(() => {
  resetOpenTuiSubstrateAvailabilityForTests();
});

describe("makeLandoEventConsumer — split-footer substrate routing", () => {
  test("acquires the split-footer lazily on the first task tree event", async () => {
    const { io, stdout } = ttyIo();
    const controller = new FakeController();
    let acquisitions = 0;
    await Effect.runPromise(
      drive(
        io,
        () => {
          acquisitions += 1;
          return Promise.resolve(controller);
        },
        [warn("prompt-only output")],
      ),
    );

    expect(acquisitions).toBe(0);
    expect(stdout()).toContain("prompt-only output");
  });

  test("renderer callbacks retained past scope close cannot mutate the live region", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    let resize: ((width: number, height: number) => void) | undefined;

    await Effect.runPromise(
      drive(
        io,
        (options) => {
          resize = options.onResize;
          return Promise.resolve(controller);
        },
        [treeStart(["web"]), taskStart("web")],
      ),
    );
    const callsAfterClose = controller.calls.length;

    resize?.(40, 12);
    await Bun.sleep(20);

    expect(controller.calls).toHaveLength(callsAfterClose);
  });

  test("does not publish expand when the alternate-screen transition fails", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    controller.enterFullTail = () => {
      throw new Error("alternate screen unavailable");
    };
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };

    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const collector = yield* events.subscribeQueue;
          yield* events.publish(treeStart(["web"]));
          yield* events.publish(taskStart("web", transcriptPath));
          yield* Effect.sleep("20 millis");
          inject?.("\r");
          yield* Effect.sleep("20 millis");
          return [...(yield* Queue.takeAll(collector))];
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(published.some((event) => event._tag === "task.detail.expand")).toBe(false);
  });

  test("does not publish collapse when restoring split-footer mode fails", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };

    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const collector = yield* events.subscribeQueue;
          yield* events.publish(treeStart(["web"]));
          yield* events.publish(taskStart("web", transcriptPath));
          yield* Effect.sleep("20 millis");
          inject?.("\r");
          yield* Effect.sleep("20 millis");
          controller.exitFullTail = () => {
            throw new Error("split footer unavailable");
          };
          inject?.("\x1b");
          yield* Effect.sleep("20 millis");
          return [...(yield* Queue.takeAll(collector))];
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(published.some((event) => event._tag === "task.detail.expand")).toBe(true);
    expect(published.some((event) => event._tag === "task.detail.collapse")).toBe(false);
  });

  test("a retried Esc collapses once after the first split-footer restore fails", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };

    const published = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const collector = yield* events.subscribeQueue;
          yield* events.publish(treeStart(["web"]));
          yield* events.publish(taskStart("web", transcriptPath));
          yield* Effect.sleep("20 millis");
          inject?.("\r");
          yield* Effect.sleep("20 millis");
          const workingExit = controller.exitFullTail.bind(controller);
          controller.exitFullTail = () => {
            throw new Error("split footer unavailable");
          };
          inject?.("\x1b");
          yield* Effect.sleep("20 millis");
          controller.exitFullTail = workingExit;
          inject?.("\x1b");
          yield* Effect.sleep("20 millis");
          return [...(yield* Queue.takeAll(collector))];
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(published.filter((event) => event._tag === "task.detail.collapse")).toHaveLength(1);
    expect(controller.calls.filter((call) => call.kind === "exitFullTail")).toHaveLength(1);
  });

  test("the default transcript reader captures the injected PathsService root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-renderer-transcript-root-"));
    const builds = join(root, "builds");
    await mkdir(builds);
    const transcriptPath = AbsolutePath.make(join(builds, "web.log"));
    await writeFile(transcriptPath, "persisted output\n");
    const { io } = ttyIo();
    const controller = new FakeController();
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    const dependencies = Layer.merge(
      EventServiceLive,
      Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: root })),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const events = yield* EventService;
            yield* events.publish(treeStart(["web"]));
            yield* events.publish(taskStart("web", transcriptPath));
            yield* Effect.sleep("20 millis");
            inject?.("\r");
            yield* Effect.sleep("20 millis");
          }).pipe(
            Effect.provide(
              Layer.provideMerge(
                makeLandoEventConsumer(interactiveIo, {
                  createLiveRegion: () => Promise.resolve(controller),
                }),
                dependencies,
              ),
            ),
          ),
        ),
      );

      const latest = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
      expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("persisted output");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("journals imperative renderer output for split-footer replay", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const events = yield* EventService;
          yield* renderer.message.info("before tree");
          yield* events.publish(treeStart(["web"]));
          yield* events.publish(taskStart("web"));
          yield* Effect.sleep("20 millis");
          yield* renderer.output.stdout("after tree\n");
          yield* Effect.sleep("20 millis");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              makeLandoService(io),
              Layer.provideMerge(
                makeLandoEventConsumer(io, {
                  createLiveRegion: () => Promise.resolve(controller),
                }),
                EventServiceLive,
              ),
            ),
          ),
        ),
      ),
    );

    const remembered = controller.calls.find((call) => call.kind === "rememberScrollback");
    expect(remembered?.kind === "rememberScrollback" && remembered.text).toContain("before tree");
    expect(controller.calls).toContainEqual({ kind: "commitScrollback", text: "after tree\n" });
  });

  test("expanded content comes from the transcript reader and live appends refresh it", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw secret one"]);
    let inject: ((raw: string) => void) | undefined;
    let publishedRawTranscript = false;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      const collector = yield* svc.subscribeQueue;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      yield* svc.publish(taskDetail("web", "[redacted]"));
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      yield* transcriptReader.append(transcriptPath, "raw secret two");
      yield* Effect.sleep("20 millis");
      publishedRawTranscript = [...(yield* Queue.takeAll(collector))].some((event) =>
        JSON.stringify(event).includes("raw secret"),
      );
    });

    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    const latest = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("raw secret two");
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).not.toContain("[redacted]");
    expect(publishedRawTranscript).toBe(false);
    expect(transcriptReader.closed).toEqual([transcriptPath]);
  });

  test("collapse ignores a late transcript callback from the closed session", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    let footerCountAfterCollapse = 0;
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      inject?.("\x1b");
      yield* Effect.sleep("20 millis");
      footerCountAfterCollapse = controller.calls.filter((call) => call.kind === "setFooter").length;
      yield* transcriptReader.fireLateChange();
      yield* Effect.sleep("20 millis");
    });

    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(controller.calls.filter((call) => call.kind === "setFooter")).toHaveLength(
      footerCountAfterCollapse,
    );
    expect(transcriptReader.closed).toEqual([transcriptPath]);
  });

  test("Enter reopens a completed task's persisted transcript after collapse", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["persisted raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      inject?.("\x1b");
      yield* svc.publish(taskComplete("web"));
      yield* svc.publish(treeComplete());
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
    });

    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(transcriptReader.opened).toEqual([transcriptPath, transcriptPath]);
    const latest = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("persisted raw output");
  });

  test("task events update the footer; message.* commits to scrollback", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [treeStart(["web"]), taskStart("web"), warn("heads up")]),
    );
    const setFooters = controller.calls.filter((c) => c.kind === "setFooter");
    expect(setFooters.length).toBeGreaterThan(0);
    expect(setFooters.at(-1)?.kind === "setFooter" && setFooters.at(-1)?.lines.join("\n")).toContain("web");
    const commits = controller.calls.filter((c) => c.kind === "commitScrollback");
    expect(commits.some((c) => c.kind === "commitScrollback" && c.text.includes("heads up"))).toBe(true);
  });

  test("tree.complete commits the summary to scrollback and retires the live footer", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [
        treeStart(["web"]),
        taskStart("web"),
        taskComplete("web"),
        treeComplete(),
      ]),
    );
    const commits = controller.calls.filter((c) => c.kind === "commitScrollback");
    expect(commits.some((c) => c.kind === "commitScrollback" && c.text.includes("done"))).toBe(true);
    const lastFooter = [...controller.calls].reverse().find((c) => c.kind === "setFooter");
    expect(lastFooter?.kind === "setFooter" && lastFooter.lines.length).toBe(0);
  });

  test("completion keeps full-tail active until Esc restores the collapsed frame", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    let exitsAfterCompletion = -1;
    let tailVisibleAfterCompletion = false;
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      yield* svc.publish(taskComplete("web"));
      yield* svc.publish(treeComplete());
      yield* Effect.sleep("20 millis");
      exitsAfterCompletion = controller.calls.filter((call) => call.kind === "exitFullTail").length;
      const latestFooter = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
      tailVisibleAfterCompletion =
        latestFooter?.kind === "setFooter" &&
        latestFooter.lines.some((line) => line.includes("expanded task tail"));
      inject?.("\x1b");
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    const enter = controller.calls.findIndex((call) => call.kind === "enterFullTail");
    const exit = controller.calls.findIndex((call) => call.kind === "exitFullTail");
    const restored = controller.calls.findIndex(
      (call, index) =>
        index > exit && call.kind === "setFooter" && call.lines.some((line) => line.includes("ready")),
    );
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(exitsAfterCompletion).toBe(0);
    expect(tailVisibleAfterCompletion).toBe(true);
    expect(exit).toBeGreaterThan(enter);
    expect(restored).toBeGreaterThan(exit);
  });

  test("Enter reopens a completed child's tail after tree completion", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(transcriptPath, ["raw output"]);
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      for (const event of [
        treeStart(["web"]),
        taskStart("web", transcriptPath),
        taskComplete("web"),
        treeComplete(),
      ]) {
        yield* svc.publish(event);
      }
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      inject?.("\x1b");
      yield* Effect.sleep("20 millis");
    });

    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    const enter = controller.calls.findIndex((call) => call.kind === "enterFullTail");
    const exit = controller.calls.findIndex((call) => call.kind === "exitFullTail");
    const restored = controller.calls.findIndex(
      (call, index) =>
        index > exit && call.kind === "setFooter" && call.lines.some((line) => line.includes("done")),
    );
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(exit).toBeGreaterThan(enter);
    expect(restored).toBeGreaterThan(exit);
  });

  test("recomputes the live footer when the substrate reports a resize", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    let resize: ((width: number, height: number) => void) | undefined;
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web"));
      yield* svc.publish(taskDetail("web", "a deliberately long build detail that must reflow"));
      yield* Effect.sleep("20 millis");
      resize?.(40, 12);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(io, {
                createLiveRegion: (options) => {
                  const candidate = Reflect.get(options, "onResize");
                  if (typeof candidate === "function") resize = candidate;
                  return Promise.resolve(controller);
                },
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    const footers = controller.calls.filter((call) => call.kind === "setFooter");
    expect(typeof resize).toBe("function");
    expect(footers.at(-1)).not.toEqual(footers.at(-2));
    const latest = footers.at(-1);
    expect(latest?.kind === "setFooter" && latest.lines.every((line) => Bun.stringWidth(line) <= 40)).toBe(
      true,
    );
  });

  test("repages an expanded transcript when resize changes its row budget", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(
      transcriptPath,
      Array.from({ length: 10 }, (_, index) => `detail ${String(index + 1).padStart(2, "0")}`),
    );
    let inject: ((raw: string) => void) | undefined;
    let resize: ((width: number, height: number) => void) | undefined;
    const interactiveIo = {
      ...io,
      terminalRows: 6,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      resize?.(80, 8);
      yield* Effect.sleep("20 millis");
      resize?.(80, 5);
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: (options) => {
                  const candidate = Reflect.get(options, "onResize");
                  if (typeof candidate === "function") resize = candidate;
                  return Promise.resolve(controller);
                },
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(typeof resize).toBe("function");
    expect(transcriptReader.reads).toEqual([
      { direction: "latest", lineLimit: 3 },
      { direction: "refresh", lineLimit: 5 },
      { direction: "refresh", lineLimit: 2 },
    ]);
    const latest = controller.calls.filter((call) => call.kind === "setFooter").at(-1);
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("detail 10");
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("detail 09");
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).not.toContain("detail 08");
  });

  test("repaints the expanded tail after eventless paging input", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const transcriptReader = new FakeTranscriptReader();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    transcriptReader.set(
      transcriptPath,
      Array.from({ length: 10 }, (_, index) => `detail ${String(index + 1).padStart(2, "0")}`),
    );
    let inject: ((raw: string) => void) | undefined;
    const interactiveIo = {
      ...io,
      terminalRows: 6,
      subscribeInput: (listener: (raw: string) => void) => {
        inject = listener;
        return () => {};
      },
    };
    let footerCountBeforePaging = 0;
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web", transcriptPath));
      for (let index = 1; index <= 10; index += 1) {
        yield* svc.publish(taskDetail("web", `detail ${String(index).padStart(2, "0")}`));
      }
      yield* Effect.sleep("20 millis");
      inject?.("\r");
      yield* Effect.sleep("20 millis");
      footerCountBeforePaging = controller.calls.filter((call) => call.kind === "setFooter").length;
      inject?.("\x1b[5~");
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(interactiveIo, {
                createLiveRegion: () => Promise.resolve(controller),
                transcriptReader,
              }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    const footers = controller.calls.filter((call) => call.kind === "setFooter");
    expect(footers).toHaveLength(footerCountBeforePaging + 1);
    const latest = footers.at(-1);
    expect(latest?.kind === "setFooter" && latest.lines.join("\n")).toContain("detail 07");
  });

  test("a running task requests live rendering only after the spinner threshold and drops on progress", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    const program = Effect.gen(function* () {
      const svc = yield* EventService;
      yield* svc.publish(treeStart(["web"]));
      yield* svc.publish(taskStart("web"));
      yield* Effect.sleep("50 millis");
      expect(controller.calls.some((call) => call.kind === "requestLive")).toBe(false);

      yield* Effect.sleep("70 millis");
      const footer = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
      expect(controller.calls.filter((call) => call.kind === "requestLive")).toHaveLength(1);
      expect(footer?.kind === "setFooter" && footer.lines.join("\n")).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);

      yield* Effect.sleep("40 millis");
      const nextFooter = [...controller.calls].reverse().find((call) => call.kind === "setFooter");
      expect(nextFooter).not.toEqual(footer);

      yield* svc.publish(
        Schema.decodeUnknownSync(TaskDetailEvent)({
          _tag: "task.detail",
          taskId: "web",
          stream: "stdout",
          line: "progress",
          timestamp: ts,
        }),
      );
      yield* Effect.sleep("20 millis");
    });
    await Effect.runPromise(
      Effect.scoped(
        program.pipe(
          Effect.provide(
            Layer.provideMerge(
              makeLandoEventConsumer(io, { createLiveRegion: () => Promise.resolve(controller) }),
              EventServiceLive,
            ),
          ),
        ),
      ),
    );

    expect(controller.calls.filter((call) => call.kind === "dropLive")).toHaveLength(1);
  });

  test("the controller is disposed exactly once when the consumer scope closes", async () => {
    const { io } = ttyIo();
    const controller = new FakeController();
    await Effect.runPromise(
      drive(io, () => Promise.resolve(controller), [treeStart(["web"]), taskStart("web")]),
    );
    expect(controller.calls.filter((c) => c.kind === "dispose")).toHaveLength(1);
  });
});

describe("makeLandoEventConsumer — degradation to line mode", () => {
  test("a TTY IO without externalOutputStream never constructs the controller and writes line output", async () => {
    const stdout: string[] = [];
    const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 80 });
    const io = { ...base, writeStdout: (chunk: string) => stdout.push(chunk) };
    let created = false;
    await Effect.runPromise(
      drive(
        io,
        () => {
          created = true;
          return Promise.resolve(new FakeController());
        },
        [treeStart(["web"]), taskStart("web")],
      ),
    );
    expect(created).toBe(false);
    expect(stdout.join("")).toContain("web");
  });

  test("a controller load failure falls back to line output without crashing", async () => {
    const { io, stdout } = ttyIo();
    const debugMessages: string[] = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === LogLevel.Debug) debugMessages.push(String(message));
    });
    await Effect.runPromise(
      drive(io, () => Promise.reject(new Error("no native binding")), [
        treeStart(["web"]),
        taskStart("web"),
      ]).pipe(
        Logger.withMinimumLogLevel(LogLevel.Debug),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    expect(stdout()).toContain("web");
    expect(debugMessages).toContain("OpenTUI live region unavailable; degrading to line rendering.");
  });

  test("two consumers share one failed acquisition attempt and one degradation notice", async () => {
    const first = ttyIo();
    const second = ttyIo();
    const debugMessages: string[] = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === LogLevel.Debug) debugMessages.push(String(message));
    });
    let attempts = 0;
    const createLiveRegion = (): Promise<FakeController> => {
      attempts += 1;
      return Promise.reject(new Error("no native binding"));
    };

    for (const { io } of [first, second]) {
      await Effect.runPromise(
        drive(io, createLiveRegion, [treeStart(["web"]), taskStart("web")]).pipe(
          Logger.withMinimumLogLevel(LogLevel.Debug),
          Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
        ),
      );
    }

    expect(attempts).toBe(1);
    expect(debugMessages).toEqual(["OpenTUI live region unavailable; degrading to line rendering."]);
    expect(first.stdout()).toContain("web");
    expect(second.stdout()).toContain("web");
  });
});
