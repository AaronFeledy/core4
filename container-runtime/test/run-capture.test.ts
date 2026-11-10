import { expect, test } from "bun:test";
import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { Effect, Stream } from "effect";
import { FakeEngine } from "./support/fake-engine.ts";

test("runStream captures complete large output before log retention can discard it", async () => {
  const expected = Buffer.alloc(8 * 1024 * 1024, "payload\n");
  const engine = new FakeEngine({ stdout: expected, frameSize: 65536, logLimit: 1024 });
  let attached = false;
  engine.observers.set("container.attach", () => {
    attached = true;
  });
  engine.observers.set("container.start", () => {
    expect(attached).toBe(true);
  });
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor: { redactString: (value) => value, redactValue: (value) => value },
    api: engine.api,
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
