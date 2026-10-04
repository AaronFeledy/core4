import { expect, test } from "bun:test";
import { Effect, Layer, Option, Tracer } from "effect";

import { EventService, type LandoEvent } from "@lando/sdk/services";

import * as LandoEventService from "@lando/engine/services/event-service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { CliInvocationSnapshot } from "../../src/cli/command-lifecycle.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const makeRecordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const spanTree = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
  spans.map((span) => ({
    name: span.name,
    parent: Option.match(span.parent, {
      onNone: () => undefined,
      onSome: (parent) => (parent._tag === "Span" ? parent.name : "external"),
    }),
  }));

const invocation: CliInvocationSnapshot = {
  commandId: "app:info",
  argv: ["app:info"],
  args: {},
  flags: {},
  cwd: "/tmp/command-spans",
  invocationId: "inv123",
};

const probe = Effect.fn("Probe.work")(function* (fail: boolean) {
  if (fail) return yield* Effect.fail(new Error("probe failed"));
  return "executed";
});

const run = (effect: Effect.Effect<string, Error>, tracer?: Tracer.Tracer) => {
  const events: LandoEvent[] = [];
  const io = createBufferedRendererIO();
  const eventLayer = Layer.effect(
    EventService,
    Effect.map(Effect.service(EventService), (inner) =>
      EventService.of({
        ...inner,
        publish: (event) =>
          Effect.andThen(
            Effect.sync(() => void events.push(event)),
            inner.publish(event),
          ),
      }),
    ),
  ).pipe(Layer.provide(LandoEventService.layer));
  return runWithRendererHandling(effect, {
    runtime: eventLayer,
    io,
    rendererMode: "plain",
    resultFormat: "text",
    command: "app:info",
    invocation,
    formatError: String,
    render: (result) => result,
    setExitCode: () => undefined,
    ...(tracer === undefined ? {} : { tracer }),
  }).then(() => ({ events, io }));
};

test("runs a dispatched command under one root span with init, run, and render children", async () => {
  // Given
  const { spans, tracer } = makeRecordingTracer();
  // When
  const { events, io } = await run(probe(false), tracer);
  // Then
  expect(io.stdout()).toContain("executed");
  expect(spanTree(spans)).toEqual([
    { name: "lando app:info", parent: undefined },
    { name: "CommandLifecycle.init", parent: "lando app:info" },
    { name: "CommandLifecycle.run", parent: "lando app:info" },
    { name: "Probe.work", parent: "CommandLifecycle.run" },
    { name: "CommandLifecycle.render", parent: "lando app:info" },
  ]);
  const [root, ...children] = spans;
  expect(Object.fromEntries(root?.attributes ?? [])).toEqual({
    "lando.command.id": "app:info",
    "lando.invocation.id": "inv123",
  });
  for (const child of children.filter((span) => span.name.startsWith("CommandLifecycle."))) {
    expect(child.attributes.size).toBe(0);
  }
  const init = spans.find((span) => span.name === "CommandLifecycle.init");
  const runSpan = spans.find((span) => span.name === "CommandLifecycle.run");
  const render = spans.find((span) => span.name === "CommandLifecycle.render");
  const ended = (span: Tracer.NativeSpan | undefined) => {
    if (span?.status._tag !== "Ended") throw new Error(`${span?.name} did not end`);
    return span.status;
  };
  expect(ended(init).endTime <= ended(runSpan).startTime).toBe(true);
  expect(ended(runSpan).endTime <= ended(render).startTime).toBe(true);
  const lifecycle = events.filter((event) => event._tag.startsWith("cli-app:info-"));
  expect(lifecycle.map((event) => event._tag)).toEqual(["cli-app:info-init", "cli-app:info-run"]);
  for (const event of lifecycle) {
    expect((event as { readonly invocationId?: string }).invocationId).toBe("inv123");
  }
});

test("keeps the init, run, and render stages when the command fails", async () => {
  // Given
  const { spans, tracer } = makeRecordingTracer();
  // When
  const { io } = await run(probe(true), tracer);
  // Then
  expect(io.stderr()).toContain("probe failed");
  expect(spanTree(spans)).toEqual([
    { name: "lando app:info", parent: undefined },
    { name: "CommandLifecycle.init", parent: "lando app:info" },
    { name: "CommandLifecycle.run", parent: "lando app:info" },
    { name: "Probe.work", parent: "CommandLifecycle.run" },
    { name: "CommandLifecycle.render", parent: "lando app:info" },
  ]);
  expect(spans.every((span) => span.status._tag === "Ended")).toBe(true);
});

test("records no command spans unless the boundary is given a tracer", async () => {
  // Given
  const { spans, tracer } = makeRecordingTracer();
  // When
  await run(probe(false).pipe(Effect.provideService(Tracer.Tracer, tracer)));
  // Then
  expect(spans).toHaveLength(0);
});
