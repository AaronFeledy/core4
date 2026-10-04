import { afterEach, expect, test } from "bun:test";
import { CORE_VERSION } from "@lando/engine/version";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, ErrorReporter, Layer, Schema, Tracer } from "effect";
import { formatCommandTrace, makeCommandTracer } from "../../src/cli/command-tracer";
import {
  runCompiledCommand,
  setActiveCommandId,
  setActiveResultFormat,
} from "../../src/cli/compiled-runtime";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { resolveTrace, setActiveTrace } from "../../src/cli/trace-selection";
import { runTracingCommand as run } from "./command-tracing-fixture";

afterEach(() => {
  setActiveTrace(undefined);
  setActiveResultFormat("text");
});

const ResultSchema = Schema.Struct({ message: Schema.String });

test("includes a complete trace in success and failure envelopes with secrets redacted", async () => {
  for (const failure of [false, true]) {
    const secret = `env-secret-669-${failure}`;
    const { io, exitCode } = await run({ format: "json", failure, secret });
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(envelope.ok).toBe(!failure);
    expect(exitCode).toBe(failure ? 1 : 0);
    const root = envelope.trace?.spans.find((span) => span.parent === undefined);
    expect(root).toMatchObject({
      name: "lando meta:probe",
      status: failure ? "error" : "ok",
      startOffsetMs: 0,
    });
    expect(envelope.trace?.spans.map((span) => span.name)).toContain("CommandLifecycle.render");
    expect(envelope.trace?.totalDurationMs).toBeGreaterThan(0);
    expect(io.stdout()).not.toContain(secret);
    expect(io.stdout()).not.toContain("flag-secret-669");
    expect(io.stdout()).not.toContain("header-secret-669");
    expect(io.stderr()).toBe("");
  }
});

test("writes the text timing tree after the result without leaking secrets", async () => {
  const { io, writes } = await run({ secret: "env-secret-text-669" });
  expect(writes[0]).toContain("stdout:completed");
  expect(writes.at(-1)).toContain("stderr:lando meta:probe");
  expect(io.stderr()).toContain("ms [ok]");
  expect(io.stdout() + io.stderr()).not.toContain("env-secret-text-669");
  expect(io.stdout() + io.stderr()).not.toContain("flag-secret-669");
});

test("carries the same trace contract in YAML", async () => {
  const { io } = await run({ format: "yaml" });
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(Bun.YAML.parse(io.stdout()));
  expect(envelope.trace?.spans[0]?.name).toBe("lando meta:probe");
});

test("bounds finished retention, counts overflow, and preserves the root", async () => {
  const capture = makeCommandTracer({ redactor: createStandaloneRedactor("secrets"), capacity: 2 });
  await Effect.runPromise(
    Effect.useSpan("lando cap", { root: true }, () =>
      Effect.gen(function* () {
        for (let index = 0; index < 4; index += 1) yield* Effect.useSpan(`child ${index}`, () => Effect.void);
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, capture.tracer)),
  );
  expect(capture.snapshot().spans).toHaveLength(2);
  expect(capture.snapshot().droppedSpans).toBe(3);
  expect(capture.snapshot().spans.some((span) => span.name === "lando cap")).toBe(true);
  expect(makeCommandTracer({ redactor: createStandaloneRedactor("secrets") }).capacity).toBe(10_000);
});

test("collapses sub-one-percent descendants on their visible parent", () => {
  const tree = formatCommandTrace({
    totalDurationMs: 100,
    droppedSpans: 0,
    spans: [
      { id: "root", name: "lando collapse", durationMs: 100, startOffsetMs: 0, status: "ok", attributes: {} },
      {
        id: "tiny",
        parent: "root",
        name: "tiny",
        durationMs: 0.5,
        startOffsetMs: 1,
        status: "ok",
        attributes: {},
      },
      {
        id: "nested",
        parent: "tiny",
        name: "nested",
        durationMs: 0.1,
        startOffsetMs: 1.1,
        status: "ok",
        attributes: {},
      },
    ],
  });
  expect(tree).toContain("2 spans under 1%");
  expect(tree).not.toContain("tiny");
});

test("exports redacted spans to the base endpoint after completion", async () => {
  const requests: { path: string; body: string; team: string | null }[] = [];
  let completed = false;
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(completed).toBe(true);
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.text(),
        team: request.headers.get("x-team"),
      });
      return Response.json({});
    },
  });
  try {
    const { exitCode, io } = await run({
      endpoint: `${receiver.url}/`,
      display: false,
      secret: "env-secret-export-669",
      resultToken: "command-result-token-669",
      onResult: () => {
        completed = true;
      },
    });
    expect(exitCode).toBe(0);
    expect(io.stderr()).toBe("");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/traces");
    expect(requests[0]?.team).toBe("header-secret-669");
    const body = requests[0]?.body ?? "";
    expect(body).toContain('"key":"service.name","value":{"stringValue":"lando"}');
    expect(body).toContain(`"key":"service.version","value":{"stringValue":"${CORE_VERSION}"}`);
    expect(body).toContain(`"key":"os.type","value":{"stringValue":"${process.platform}"}`);
    expect(body).toContain(`"key":"host.arch","value":{"stringValue":"${process.arch}"}`);
    expect(body).toContain("lando meta:probe");
    expect(body).not.toContain("env-secret-export-669");
    expect(body).not.toContain("flag-secret-669");
    expect(body).not.toContain("header-secret-669");
    expect(body).not.toContain("command-result-token-669");
    expect(io.stdout()).not.toContain("command-result-token-669");
  } finally {
    await receiver.stop(true);
  }
});

test("redacts defect causes before OTLP serializes error events", async () => {
  const payloads: string[] = [];
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      payloads.push(await request.text());
      return Response.json({});
    },
  });
  try {
    const { exitCode } = await run({
      endpoint: String(receiver.url),
      failure: true,
      secret: "defect-secret-669",
      format: "json",
    });
    expect(exitCode).toBe(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain("exception.message");
    expect(payloads[0]).not.toContain("defect-secret-669");
  } finally {
    await receiver.stop(true);
  }
});

test("bounds a stalled exporter without delaying completion or changing status", async () => {
  // Bun's stop(true) waits on unsettled handlers even after the client aborts, so teardown releases the stall.
  let release = () => {};
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null));
      }),
  });
  const started = performance.now();
  let resultAt = Number.POSITIVE_INFINITY;
  try {
    const { exitCode, io } = await run({
      endpoint: String(receiver.url),
      onResult: () => {
        resultAt = performance.now() - started;
      },
    });
    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain("completed");
    expect(resultAt).toBeLessThan(500);
    expect(performance.now() - started).toBeLessThan(1_300);
  } finally {
    release();
    await receiver.stop(true);
  }
});

test("omits tracing and makes no request when tracing and endpoint are unset", async () => {
  let requests = 0;
  const receiver = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json({});
    },
  });
  const io = createBufferedRendererIO();
  try {
    await runWithRendererHandling(Effect.succeed({ message: "untraced" }), {
      runtime: Layer.empty,
      io,
      rendererMode: "plain",
      resultFormat: "json",
      resultSchema: ResultSchema,
      trace: resolveTrace({ env: { OTEL_EXPORTER_OTLP_HEADERS: `endpoint=${receiver.url}` } }),
      formatError: String,
    });
    expect(requests).toBe(0);
    expect(JSON.parse(io.stdout())).not.toHaveProperty("trace");
  } finally {
    await receiver.stop(true);
  }
});

test("passes the selected tracer through the compiled command boundary", async () => {
  setActiveTrace(resolveTrace({ argv: ["--trace"], env: {} }));
  setActiveCommandId("meta:version");
  setActiveResultFormat("json");
  const io = createBufferedRendererIO();
  await runCompiledCommand(
    Effect.succeed({ core: "test", bun: "test", platform: "linux" }),
    Layer.empty,
    () => "version",
    { io },
  );
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
  expect(envelope.trace?.spans[0]?.name).toBe("lando meta:version");
});

test("deduplicates nested defect reports into one existing failure rendering", async () => {
  const io = createBufferedRendererIO();
  const defect = new Error("nested-defect-669");
  const program = Effect.gen(function* () {
    const reporters = yield* Effect.service(ErrorReporter.CurrentErrorReporters);
    expect(reporters.size).toBe(1);
    return yield* Effect.die(defect).pipe(Effect.withErrorReporting({ defectsOnly: true }));
  });
  await runWithRendererHandling(program, {
    runtime: Layer.empty,
    io,
    rendererMode: "plain",
    resultFormat: "json",
    formatError: String,
    setExitCode: () => {},
  });
  expect(io.stdout().trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(io.stdout()).error.message).toBe("nested-defect-669");
});

test("marks the root and render spans failed when jq rendering fails", async () => {
  const requests: string[] = [];
  const receiver = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push(await request.text());
      return Response.json({});
    },
  });
  const io = createBufferedRendererIO();
  let exitCode = 0;
  try {
    await runWithRendererHandling(Effect.succeed({ message: "completed" }), {
      runtime: Layer.empty,
      io,
      rendererMode: "plain",
      resultFormat: "json",
      command: "meta:probe",
      resultSchema: ResultSchema,
      jqExpression: 'error("qa-jq-failure")',
      trace: resolveTrace({
        argv: ["--trace"],
        env: {},
        config: { otlp: { endpoint: String(receiver.url), headers: {} } },
      }),
      formatError: String,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    expect(exitCode).toBe(2);
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(io.stdout()));
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ _tag: "JqExpressionError" });
    const root = envelope.trace?.spans.find((span) => span.parent === undefined);
    const render = envelope.trace?.spans.find((span) => span.name === "CommandLifecycle.render");
    expect(root).toMatchObject({ name: "lando meta:probe", status: "error" });
    expect(render).toMatchObject({ status: "error" });
    expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0] ?? "{}") as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{ spans?: Array<{ name?: string; status?: { code?: number } }> }>;
      }>;
    };
    const exported = payload.resourceSpans?.flatMap(
      (resource) => resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [],
    );
    for (const name of ["lando meta:probe", "CommandLifecycle.render"]) {
      expect(exported?.find((span) => span.name === name)?.status?.code).toBe(2);
    }
  } finally {
    await receiver.stop(true);
  }
});
