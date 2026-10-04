import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { Effect, Tracer } from "effect";
import { makeCommandTracer } from "../../src/cli/command-tracer";

test("exports every finished delegate span independently of local retention overflow", async () => {
  const exported: Tracer.NativeSpan[] = [];
  const delegate = Tracer.make({
    span(input) {
      const span = new Tracer.NativeSpan(input);
      exported.push(span);
      return span;
    },
  });
  const capture = makeCommandTracer({ redactor: createStandaloneRedactor("secrets"), delegate, capacity: 2 });
  await Effect.runPromise(
    Effect.useSpan("lando overflow", { root: true }, () =>
      Effect.gen(function* () {
        for (let index = 0; index < 5; index += 1) yield* Effect.useSpan(`child ${index}`, () => Effect.void);
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, capture.tracer)),
  );
  await Effect.runPromise(capture.exportSpans);
  expect(capture.snapshot().spans).toHaveLength(2);
  expect(capture.snapshot().droppedSpans).toBe(4);
  expect(exported).toHaveLength(6);
  expect(exported.every((span) => span.status._tag === "Ended")).toBe(true);
});

test("re-scrubs deferred event attributes with final command redaction tokens", async () => {
  const exported: Tracer.NativeSpan[] = [];
  const delegate = Tracer.make({
    span(input) {
      const span = new Tracer.NativeSpan(input);
      exported.push(span);
      return span;
    },
  });
  const capture = makeCommandTracer({ redactor: createStandaloneRedactor("secrets"), delegate });
  await Effect.runPromise(
    Effect.useSpan("lando event", { root: true }, (span) =>
      Effect.sync(() => {
        span.event("work", 0n, { commandValue: "late-event-secret-669" });
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, capture.tracer)),
  );
  capture.setRedactor(createStandaloneRedactor("secrets", { redactionTokens: ["late-event-secret-669"] }));
  await Effect.runPromise(capture.exportSpans);
  expect(exported[0]?.events[0]?.[2]).toEqual({ commandValue: "[redacted]" });
});
