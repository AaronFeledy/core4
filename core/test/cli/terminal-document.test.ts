import { describe, expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { makePlainRenderer } from "@lando/renderer/runtime";
import { Renderer } from "@lando/sdk/services";
import { type Cause, Deferred, Effect, Fiber, Layer } from "effect";
import {
  type TerminalDocument,
  diagnosticLine,
  makeTerminalCommitter,
  resultLine,
  warningMessage,
} from "../../src/cli/terminal-document";

const document = (
  overrides: { readonly stdout?: ReadonlyArray<string>; readonly exitCode?: number } = {},
): TerminalDocument => ({
  writes: [
    ...(overrides.stdout ?? ["result"]).map(resultLine),
    diagnosticLine("diagnostic"),
    warningMessage("notice"),
  ],
  exitCode: overrides.exitCode ?? 3,
});

/** A plain renderer over buffered IO whose stdout writes go through `stdout`. */
const rendererWith = (stdout?: (chunk: string | Uint8Array) => Effect.Effect<void>) => {
  const io = createBufferedRendererIO();
  const plain = makePlainRenderer(io);
  const renderer = Renderer.of({
    id: plain.id,
    capabilities: plain.capabilities,
    message: plain.message,
    output: { stdout: stdout ?? plain.output.stdout, stderr: plain.output.stderr },
  });
  return { io, layer: Layer.succeed(Renderer, renderer) };
};

const committerFor = (options: { readonly signal?: AbortSignal; readonly brokenPipe?: boolean } = {}) => {
  const codes: number[] = [];
  const defects: Cause.Cause<unknown>[] = [];
  const committer = makeTerminalCommitter({
    signal: options.signal,
    setExitCode: (code) => codes.push(code),
    brokenPipe: () => options.brokenPipe === true,
    recordDefect: (cause) =>
      Effect.sync(() => {
        defects.push(cause);
      }),
  });
  return { committer, codes, defects };
};

describe("the terminal committer", () => {
  test("writes the first document and its status, and ignores every later commit", async () => {
    // Given a committer and a buffered renderer.
    const { io, layer } = rendererWith();
    const { committer, codes } = committerFor();
    // When two documents are committed.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* committer.commit(document());
        yield* committer.commit(document({ stdout: ["second"], exitCode: 9 }));
      }).pipe(Effect.provide(layer)),
    );
    // Then only the first document was written, with one status.
    expect(io.stdout()).toBe("result\n");
    expect(io.stderr()).toContain("diagnostic\n");
    expect(io.stderr()).toContain("notice");
    expect(io.stderr()).not.toContain("second");
    expect(codes).toEqual([3]);
    expect(committer.attempted()).toBe(true);
  });

  test("a write that fails partway stops the document and sets the failure status once", async () => {
    // Given stdout that accepts one line and then fails.
    const written: string[] = [];
    const { io, layer } = rendererWith((chunk) =>
      written.length === 0
        ? Effect.sync(() => {
            written.push(String(chunk));
          })
        : Effect.die(new Error("stdout write failed")),
    );
    const { committer, codes, defects } = committerFor();
    // When a three-line document and then another document are committed.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* committer.commit(document({ stdout: ["one", "two", "three"], exitCode: 0 }));
        yield* committer.commit(document({ exitCode: 0 }));
      }).pipe(Effect.provide(layer)),
    );
    // Then the run fails once, the defect is recorded, and nothing after the failure is written.
    expect(written).toEqual(["one\n"]);
    expect(io.stderr()).toBe("");
    expect(codes).toEqual([1]);
    expect(defects).toHaveLength(1);
  });

  test("an abort during a write abandons the document and sets the interruption status once", async () => {
    // Given stdout that blocks once the run is cancelled mid-write.
    const controller = new AbortController();
    const { io, layer } = rendererWith(() =>
      Effect.sync(() => controller.abort("SIGINT")).pipe(Effect.andThen(Effect.never)),
    );
    const { committer, codes, defects } = committerFor({ signal: controller.signal });
    // When the document is committed.
    await Effect.runPromise(committer.commit(document({ exitCode: 0 })).pipe(Effect.provide(layer)));
    // Then the blocked write is abandoned, the rest is skipped, and the status is the interruption code.
    expect(io.stderr()).toBe("");
    expect(codes).toEqual([130]);
    expect(defects).toEqual([]);
  });

  test("an interrupted commit sets the interruption status, except after a broken pipe", async () => {
    for (const brokenPipe of [false, true]) {
      // Given stdout that never accepts the write.
      const writing = Effect.runSync(Deferred.make<void>());
      const { layer } = rendererWith(() =>
        Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const { committer, codes } = committerFor({ brokenPipe });
      // When the commit is interrupted while it writes.
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(committer.commit(document()));
          yield* Deferred.await(writing);
          yield* Fiber.interrupt(fiber);
          yield* committer.commit(document());
        }).pipe(Effect.provide(layer)),
      );
      // Then the status is set once, or left to the process broken-pipe policy.
      expect(codes).toEqual(brokenPipe ? [] : [1]);
    }
  });
});
