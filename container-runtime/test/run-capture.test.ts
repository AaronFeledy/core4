import { expect, test } from "bun:test";
import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { Deferred, Effect, Stream } from "effect";

test("runStream captures complete large output before log retention can discard it", async () => {
  const started = await Effect.runPromise(Deferred.make<void>());
  const expected = Buffer.alloc(8 * 1024 * 1024, "payload\n");
  const frame = Buffer.alloc(expected.length + 8);
  frame[0] = 1;
  frame.writeUInt32BE(expected.length, 4);
  expected.copy(frame, 8);
  let attached = false;
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor: { redactString: (value) => value, redactValue: (value) => value },
    api: {
      request: (request) =>
        Effect.gen(function* () {
          if (request.path.endsWith("/start")) {
            expect(attached).toBe(true);
            yield* Deferred.succeed(started, undefined);
          }
          return { status: 200, body: request.path.endsWith("/json") ? '{"State":{"ExitCode":0}}' : "{}" };
        }),
      stream: (request) => {
        if (!request.path.includes("/attach?")) return Stream.make(frame.subarray(0, 1024));
        attached = true;
        request.onResponseHead?.();
        return Stream.fromEffect(Deferred.await(started)).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable(
              Array.from({ length: Math.ceil(frame.length / 65536) }, (_, index) =>
                frame.subarray(index * 65536, (index + 1) * 65536),
              ),
            ),
          ),
        );
      },
    },
  });
  const chunks = await Effect.runPromise(
    plane
      .runStream({
        image: "test",
        command: ["emit-payload"],
        captureStdout: true,
      })
      .pipe(Stream.runCollect, Effect.scoped),
  );
  expect(Buffer.concat(chunks.flatMap((chunk) => ("chunk" in chunk ? [chunk.chunk] : [])))).toEqual(expected);
  expect(chunks.filter((chunk) => "exitCode" in chunk)).toEqual([{ exitCode: 0 }]);
});
