import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRedactionService } from "@lando/redaction/service";
import { LOG_LINE_TRUNCATED_MARKER } from "@lando/sdk/log-follow";
import { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { Deferred, Effect, Fiber } from "effect";
import type { BuildRedaction } from "../../src/services/build-redaction.ts";
import { openBuildStepOutput } from "../../src/services/build-step-output.ts";

const encoder = new TextEncoder();

const withTempRoots = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-build-step-output-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeRedaction = (values: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const service = makeRedactionService();
    yield* service.registerValues(values);
    const options = { sourceEnv: {} };
    return {
      redactor: yield* service.forProfile("secrets", options),
      payloadValues: yield* service.payloadValues(options),
    } satisfies BuildRedaction;
  });

const makePublisher = () => {
  const published: LandoEvent[] = [];
  return {
    published,
    events: {
      publish: (event: LandoEvent) =>
        Effect.sync(() => {
          published.push(event);
        }),
    },
  };
};

const transcriptFor = (root: string, name: string) =>
  AbsolutePath.make(join(root, "builds", "app", "web", `${name}.log`));

describe("openBuildStepOutput", () => {
  test("redacts the same secret for every chunk boundary", async () => {
    await withTempRoots(async (root) => {
      // Given a secret split arbitrarily across writes.
      const secret = "split-secret-value";
      const output = encoder.encode(`before ${secret} after\n`);
      const transcripts: string[] = [];

      for (const size of [1, 7, output.length]) {
        // When
        const publisher = makePublisher();
        const redaction = await Effect.runPromise(makeRedaction([secret]));
        const transcriptPath = transcriptFor(root, `chunk-${size}`);
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const recorder = yield* openBuildStepOutput({
                events: publisher.events,
                taskId: "web:app:install",
                transcriptPath,
                providerId: "test",
                userDataRoot: root,
                redaction,
              });
              for (let offset = 0; offset < output.length; offset += size) {
                yield* recorder.write("stdout", output.subarray(offset, offset + size));
              }
              yield* recorder.end;
            }),
          ),
        );

        // Then
        const transcript = await readFile(transcriptPath, "utf8");
        expect(transcript).toBe("before [redacted] after\n");
        expect(transcript).not.toContain(secret);
        expect(JSON.stringify(publisher.published)).not.toContain(secret);
        expect(publisher.published).toEqual([
          expect.objectContaining({ _tag: "task.detail", stream: "stdout", line: "before [redacted] after" }),
        ]);
        transcripts.push(transcript);
      }

      expect(new Set(transcripts).size).toBe(1);
    });
  });

  test("redacts a registered value that spans lines", async () => {
    await withTempRoots(async (root) => {
      // Given a value whose bytes cross a line boundary.
      const secret = "multi-line-secret\nstill-secret";
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction([secret]));
      const transcriptPath = transcriptFor(root, "multiline");

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode(`before ${secret} after\n`));
            yield* recorder.end;
          }),
        ),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("before [redacted] after\n");
    });
  });

  test("flushes an unterminated line through redaction into transcript, tail, and events", async () => {
    await withTempRoots(async (root) => {
      // Given
      const secret = "unterminated-secret";
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction([secret]));
      const transcriptPath = transcriptFor(root, "unterminated");
      let tailBeforeEnd: string | undefined;
      let tailAfterEnd: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode(`token=${secret}`));
            tailBeforeEnd = recorder.tail();
            yield* recorder.end;
            tailAfterEnd = recorder.tail();
          }),
        ),
      );

      // Then
      expect(tailBeforeEnd).toBeUndefined();
      expect(await readFile(transcriptPath, "utf8")).toBe("token=[redacted]\n");
      expect(tailAfterEnd).toBe("token=[redacted]");
      expect(JSON.stringify(publisher.published)).not.toContain(secret);
      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0]).toMatchObject({
        _tag: "task.detail",
        stream: "stdout",
        line: "token=[redacted]",
      });
    });
  });

  test("redacts a value registered after the recorder opened", async () => {
    await withTempRoots(async (root) => {
      // Given a live redaction scope.
      const service = makeRedactionService();
      const options = { sourceEnv: {} };
      const redaction: BuildRedaction = {
        redactor: await Effect.runPromise(service.forProfile("secrets", options)),
        payloadValues: await Effect.runPromise(service.payloadValues(options)),
      };
      const publisher = makePublisher();
      const transcriptPath = transcriptFor(root, "late-registration");

      // When the value is registered after the output stream started.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode("first\n"));
            yield* service.registerValues(["late-secret"]);
            yield* recorder.write("stdout", encoder.encode("late-secret\n"));
            yield* recorder.end;
          }),
        ),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("first\n[redacted]\n");
    });
  });

  test("publishes both streams in arrival order with their stream identity", async () => {
    await withTempRoots(async (root) => {
      // Given
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction());
      const transcriptPath = transcriptFor(root, "streams");

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode("out\n"));
            yield* recorder.write("stderr", encoder.encode("err\n"));
            yield* recorder.end;
          }),
        ),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("out\nerr\n");
      expect(
        publisher.published.map((event) => (event._tag === "task.detail" ? [event.stream, event.line] : [])),
      ).toEqual([
        ["stdout", "out"],
        ["stderr", "err"],
      ]);
    });
  });

  test.each([10, 300])("bounds the tail with %i-character line prefixes", async (width) => {
    await withTempRoots(async (root) => {
      // Given more output than the tail retains.
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction());
      const transcriptPath = transcriptFor(root, "tail-bounds");
      let tail: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write(
              "stdout",
              encoder.encode(
                `${Array.from({ length: 30 }, (_, index) => `${"x".repeat(width)}-${index + 1}`).join("\n")}\n`,
              ),
            );
            yield* recorder.end;
            tail = recorder.tail();
          }),
        ),
      );

      // Then
      expect(tail).toBeDefined();
      if (tail === undefined) throw new TypeError("tail is missing");
      expect(tail.length).toBeLessThanOrEqual(4096);
      const lines = tail.split("\n");
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(lines).toHaveLength(width === 10 ? 20 : 13);
      expect(lines.at(-1)).toBe(`${"x".repeat(width)}-30`);
      for (const line of lines) expect(line).toMatch(/^x+-\d+$/u);
    });
  });

  test("redacts a credential pattern split across tail lines", async () => {
    await withTempRoots(async (root) => {
      // Given a bearer value that only forms a credential pattern when the lines are joined.
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction());
      const transcriptPath = transcriptFor(root, "tail-pattern");
      let tail: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode("Authorization: Bearer\nabc123token\n"));
            yield* recorder.end;
            tail = recorder.tail();
          }),
        ),
      );

      // Then
      expect(tail).toBeDefined();
      if (tail === undefined) throw new TypeError("tail is missing");
      expect(tail).toContain("[redacted]");
      expect(tail).not.toContain("abc123token");
    });
  });

  test("notes are redacted, unpublished, and absent from the tail", async () => {
    await withTempRoots(async (root) => {
      // Given
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction(["note-secret"]));
      const transcriptPath = transcriptFor(root, "note");
      let tail: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.note("Error: note-secret");
            yield* recorder.end;
            tail = recorder.tail();
          }),
        ),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("Error: [redacted]\n");
      expect(tail).toBeUndefined();
      expect(publisher.published).toEqual([]);
    });
  });

  test("drains held output in the scope finalizer on interruption", async () => {
    await withTempRoots(async (root) => {
      // Given a recorder holding an unterminated line when its fiber is interrupted.
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction(["held-secret"]));
      const transcriptPath = transcriptFor(root, "interrupted");
      const wrote = Deferred.makeUnsafe<void>();

      // When
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const recorder = yield* openBuildStepOutput({
                  events: publisher.events,
                  taskId: "web:app:install",
                  transcriptPath,
                  providerId: "test",
                  userDataRoot: root,
                  redaction,
                });
                yield* recorder.write("stdout", encoder.encode("held-secret"));
                yield* Deferred.succeed(wrote, undefined);
                yield* Effect.never;
              }),
            ),
          );
          yield* Deferred.await(wrote);
          yield* Fiber.interrupt(fiber);
          yield* Fiber.await(fiber);
        }),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("[redacted]\n");
    });
  });
  test("bounds the tail when registered-value redaction lengthens output", async () => {
    await withTempRoots(async (root) => {
      // Given a 17-line tail that joins to exactly 4096 characters and a value that spans a line break.
      const lineLength = 240;
      const lines = Array.from({ length: 17 }, (_, index) => {
        if (index === 1) return `${"z".repeat(lineLength - 1)}a`;
        if (index === 2) return `b${"z".repeat(lineLength - 1)}`;
        return "z".repeat(lineLength);
      });
      expect(lines.join("\n").length).toBe(4096);
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction(["a\nb"]));
      const transcriptPath = transcriptFor(root, "tail-after-redaction");
      let tail: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode(`${lines.join("\n")}\n`));
            yield* recorder.end;
            tail = recorder.tail();
          }),
        ),
      );

      // Then
      expect(tail).toBeDefined();
      expect(tail?.length).toBeLessThanOrEqual(4096);
      expect(tail).toContain("[redacted]");
      expect(tail?.endsWith("z".repeat(lineLength))).toBe(true);
    });
  });

  test("emits every framed line when its fiber is interrupted mid-chunk", async () => {
    await withTempRoots(async (root) => {
      // Given a first-line publish gated until after the writing fiber is interrupted.
      const gate = Deferred.makeUnsafe<void>();
      const firstLinePublished = Deferred.makeUnsafe<void>();
      const published: string[] = [];
      const publisher = {
        published,
        events: {
          publish: (event: LandoEvent) => {
            if (event._tag !== "task.detail" || typeof event.line !== "string") return Effect.void;
            published.push(event.line);
            return event.line === "one"
              ? Deferred.succeed(firstLinePublished, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void;
          },
        },
      };
      const redaction = await Effect.runPromise(makeRedaction());
      const transcriptPath = transcriptFor(root, "interrupted-mid-chunk");

      // When
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.scoped(
              Effect.gen(function* () {
                const recorder = yield* openBuildStepOutput({
                  events: publisher.events,
                  taskId: "web:app:install",
                  transcriptPath,
                  providerId: "test",
                  userDataRoot: root,
                  redaction,
                });
                yield* recorder.write("stdout", encoder.encode("one\ntwo\nthree\n"));
              }),
            ),
          );
          yield* Deferred.await(firstLinePublished);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true });
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(interrupting);
          yield* Fiber.await(fiber);
        }),
      );

      // Then
      expect(await readFile(transcriptPath, "utf8")).toBe("one\ntwo\nthree\n");
      expect(published).toEqual(["one", "two", "three"]);
    });
  });

  test("caps published detail and tail lines while the transcript keeps the full line", async () => {
    await withTempRoots(async (root) => {
      // Given a 5,000-character line, like the base64 run instruction an image build echoes.
      const publisher = makePublisher();
      const redaction = await Effect.runPromise(makeRedaction());
      const transcriptPath = transcriptFor(root, "display-bound");
      const long = "x".repeat(5000);
      let tail: string | undefined;

      // When
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* openBuildStepOutput({
              events: publisher.events,
              taskId: "web:app:install",
              transcriptPath,
              providerId: "test",
              userDataRoot: root,
              redaction,
            });
            yield* recorder.write("stdout", encoder.encode(`${long}\n${long}${long}\n`));
            yield* recorder.end;
            tail = recorder.tail();
          }),
        ),
      );

      // Then
      const detailLines: string[] = [];
      for (const event of publisher.published) {
        if (event._tag === "task.detail" && "line" in event && typeof event.line === "string") {
          detailLines.push(event.line);
        }
      }
      expect(detailLines).toHaveLength(2);
      const bounded = 512 + LOG_LINE_TRUNCATED_MARKER.length;
      for (const line of detailLines) {
        expect(line.length).toBe(bounded);
        expect(line.endsWith(LOG_LINE_TRUNCATED_MARKER)).toBe(true);
        expect(line.startsWith("x".repeat(512))).toBe(true);
      }
      expect(tail?.split("\n")).toEqual(detailLines);
      expect(await readFile(transcriptPath, "utf8")).toBe(`${long}\n${long}${long}\n`);
    });
  });
});
