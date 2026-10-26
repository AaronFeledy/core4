import { expect, test } from "bun:test";
import { Effect } from "effect";
import { StreamFrameSink, createCollectingStreamFrameSink } from "../../src/operations/stream-frame-sink.ts";
import { withToolingOutput } from "../../src/operations/tooling-output.ts";

for (const live of [false, true]) {
  for (const streamed of ["stdout", "stderr", "both", "neither"] as const) {
    test(`tooling output owns each channel independently: live=${live}, streamed=${streamed}`, async () => {
      // Given
      const delivered = createCollectingStreamFrameSink();
      const operation = withToolingOutput(
        Effect.gen(function* () {
          const sink = yield* StreamFrameSink;
          for (const channel of ["stdout", "stderr"] as const) {
            if (streamed === channel || streamed === "both") {
              yield* sink.emit({ _tag: channel, chunk: `streamed-${channel}`, kind: "bytes" });
            }
          }
          return { stdout: "returned-stdout", stderr: "returned-stderr", exitCode: 7 };
        }),
      );
      // When
      const result = await Effect.runPromise(
        live ? operation.pipe(Effect.provideService(StreamFrameSink, delivered.sink)) : operation,
      );
      await Effect.runPromise(delivered.finish());
      // Then
      const expected = {
        stdout: streamed === "stdout" || streamed === "both" ? "streamed-stdout" : "returned-stdout",
        stderr: streamed === "stderr" || streamed === "both" ? "streamed-stderr" : "returned-stderr",
      };
      expect(result).toEqual({ ...(live ? { stdout: "", stderr: "" } : expected), exitCode: 7 });
      expect(delivered.result()).toEqual(live ? expected : { stdout: "", stderr: "" });
    });
  }
}
