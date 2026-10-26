import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBufferedRendererIO, createStdioRendererIO } from "@lando/renderer/io";
import { withHostDumpCompression } from "@lando/sql/compression";
import { Effect, Layer, Schema } from "effect";
import { CommandWarnings } from "../../../src/cli/command-warnings";
import { runWithProcessAbortSignal } from "../../../src/cli/compiled-runtime";
import { runWithProcessSignalReraise } from "../../../src/cli/process-signals";
import { runWithRendererHandling } from "../../../src/cli/renderer-boundary";

const [directory, mode = "wait"] = process.argv.slice(2);
if (directory === undefined) throw new Error("Missing owned fixture directory");
const record = (event: string, value?: unknown) =>
  appendFileSync(join(directory, "events"), `${JSON.stringify({ event, value })}\n`);

class CleanupError extends Schema.TaggedError<CleanupError>()("SignalCleanupError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const keepAlive = setInterval(() => undefined, 1000);
try {
  await runWithProcessSignalReraise(() =>
    runWithProcessAbortSignal(async (signal) => {
      signal.addEventListener("abort", () => record("abort", signal.reason), { once: true });
      const io = createBufferedRendererIO();
      const operation = Effect.scoped(
        Effect.gen(function* () {
          const warnings = yield* Effect.serviceOption(CommandWarnings);
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              record("finalizing");
              yield* Effect.sleep(180);
              if (warnings._tag === "Some")
                yield* warnings.value.addFailureNotice("Cleanup receipt retained");
              record("finalized");
              if (mode === "cleanup-error") {
                return yield* Effect.die(
                  new CleanupError({
                    message: "Cleanup failed private-signal-token",
                    remediation: "Inspect the owned fixture",
                  }),
                );
              }
            }),
          );
          if (mode === "compressed") {
            const stdinIO = createStdioRendererIO();
            yield* Effect.acquireRelease(
              Effect.sync(() => stdinIO.subscribeInput?.(() => undefined)),
              (restore) =>
                Effect.sync(() => {
                  restore?.();
                  record("raw-restored", process.stdin.isRaw);
                }),
            );
            const dump = join(directory, "fixture.sql.gz");
            writeFileSync(dump, Bun.gzipSync("select 1;"));
            return yield* withHostDumpCompression({
              path: dump,
              direction: "import",
              compression: "gzip",
              transfer: (workingPath) =>
                Effect.sync(() =>
                  record("ready", {
                    pid: process.pid,
                    workingPath,
                    raw: process.stdin.isRaw,
                  }),
                ).pipe(Effect.andThen(Effect.never)),
            });
          }
          record("ready", { pid: process.pid });
          if (mode === "complete" || mode === "ignored") {
            yield* Effect.sleep(350);
            return {};
          }
          if (mode.startsWith("windows-")) {
            setTimeout(() => (process as NodeJS.EventEmitter).emit(mode.slice(8)), 10);
          }
          return yield* Effect.never;
        }),
      );
      const runtime = Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => record("runtime-finalized"))),
      );
      await runWithRendererHandling(operation, {
        runtime,
        signal,
        rendererMode: "plain",
        command: "fixture:signal",
        invocation: { commandId: "fixture:signal", argv: [], args: {}, flags: {}, cwd: directory },
        io,
        extraRedactionTokens: ["private-signal-token"],
        resultSchema: Schema.Struct({}),
        completion: () => ({ ok: true, exitCode: 7 }),
        render: () => "completed",
        formatError: (failure) => JSON.stringify(failure),
      });
      record("rendered", { stdout: io.stdout(), stderr: io.stderr() });
    }),
  );
} finally {
  clearInterval(keepAlive);
}
