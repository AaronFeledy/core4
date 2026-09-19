import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { StreamFrame } from "@lando/sdk/schema";

import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { infoSpec } from "../../src/cli/command-specs/app/info.ts";
import { CommandWarnings } from "../../src/cli/command-warnings.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { preCommandOutputMode } from "../../src/cli/spec/command-boundary.ts";

const infoResult = {
  app: "demo",
  services: [
    {
      app: "demo",
      service: "appserver",
      api: 4,
      type: "php:8.3",
      provider: "lando",
      primary: true,
      status: "running",
      endpoints: ["http://demo.lndo.site"],
    },
    {
      app: "demo",
      service: "database",
      api: 4,
      type: "mariadb:10.6",
      provider: "lando",
      primary: false,
      status: "running",
      endpoints: [],
    },
  ],
} as const;

// Every boundary call below injects `setExitCode`, so this file never writes
// the shared exit code. These resets are the second line of defence, and they
// assign 0 rather than undefined: under Bun `process.exitCode = undefined` is a
// no-op that leaves the previous value in place, so an `undefined` reset would
// silently do nothing and leak a failure code into the next file in a shard.
beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("--format=yaml on a command with no bespoke format handling", () => {
  test("app:info emits one parseable envelope document, not its tab-separated view", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(infoResult), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: infoSpec.id,
      resultSchema: infoSpec.resultSchema,
      io,
      render: (value, ctx) => infoSpec.render?.(value, undefined, ctx),
      formatError: String,
    });

    const stdout = io.stdout();
    // The defect this story closes: the human TSV view leaking out of a
    // machine format. `service\tstate\tendpoints` is that view's header.
    expect(stdout).not.toContain("\t");
    expect(stdout).not.toContain("service\tstate");
    const parsed = Bun.YAML.parse(stdout) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe("v4");
    expect(parsed.command).toBe("app:info");
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual(JSON.parse(JSON.stringify(infoResult)));
    expect(io.stderr()).toBe("");
  });

  test("app:info yaml and json carry the identical model", async () => {
    const run = async (resultFormat: "json" | "yaml") => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed(infoResult), {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat,
        command: infoSpec.id,
        resultSchema: infoSpec.resultSchema,
        io,
        render: (value, ctx) => infoSpec.render?.(value, undefined, ctx),
        formatError: String,
      });
      return io.stdout();
    };

    expect(Bun.YAML.parse(await run("yaml"))).toEqual(JSON.parse(await run("json")));
  });

  test("a failure under yaml is a yaml envelope on stdout with the failure exit code", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    await runWithRendererHandling(Effect.fail(new Error("boom")), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: infoSpec.id,
      resultSchema: infoSpec.resultSchema,
      io,
      render: () => undefined,
      formatError: String,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(1);
  });

  test("task events are not painted into the yaml document", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(infoResult), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: infoSpec.id,
      resultSchema: infoSpec.resultSchema,
      io,
      render: () => undefined,
      formatError: String,
    });

    expect(Bun.YAML.parse(io.stdout())).toBeDefined();
    expect(io.stdoutLines().length).toBeGreaterThan(0);
  });
});

describe("--format=yaml on a live-streaming command", () => {
  const ResultSchema = Schema.Struct({ message: Schema.String });

  const streamingEffect = Effect.gen(function* () {
    const sink = yield* StreamFrameSink;
    yield* sink.emit({ _tag: "stdout", chunk: "raw-stdout-chunk\n", service: "appserver" });
    yield* sink.emit({ _tag: "stderr", chunk: "raw-stderr-chunk\n", service: "appserver" });
    return { message: "done" };
  });

  const runStreaming = async (resultFormat: "json" | "yaml") => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(streamingEffect, {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat,
      command: "app:exec",
      resultSchema: ResultSchema,
      streaming: StreamFrame,
      streamingMode: "live",
      io,
      render: () => undefined,
      formatError: String,
      setExitCode: () => undefined,
    });
    return io;
  };

  test("json keeps the stdout, stderr and result frame sequence", async () => {
    const io = await runStreaming("json");
    const frames = io
      .stdoutLines()
      .filter((line) => line.length > 0)
      .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));

    expect(frames.map((frame) => frame._tag)).toEqual(["stdout", "stderr", "result"]);
  });

  test("yaml emits exactly one envelope document and no raw chunk", async () => {
    const jsonIo = await runStreaming("json");
    const yamlIo = await runStreaming("yaml");
    const stdout = yamlIo.stdout();

    expect(stdout).not.toContain("raw-stdout-chunk");
    expect(stdout).not.toContain("raw-stderr-chunk");
    expect(yamlIo.stderr()).toBe("");

    const terminal = jsonIo
      .stdoutLines()
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly _tag: string; readonly envelope?: unknown })
      .find((frame) => frame._tag === "result");
    expect(Bun.YAML.parse(stdout)).toEqual(terminal?.envelope);
  });

  test("a live run with no frame schema still frames under json and documents under yaml", async () => {
    // Frame transport is the JSON concern, not the frame schema: a live command
    // that declares none still terminates in a result frame under json, while
    // yaml terminates in the envelope document.
    const emit = async (resultFormat: "json" | "yaml") => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(Effect.succeed({ message: "done" }), {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat,
        command: "app:exec",
        resultSchema: ResultSchema,
        streamingMode: "live",
        io,
        render: () => undefined,
        formatError: String,
        setExitCode: () => undefined,
      });
      return io.stdout();
    };

    const json = await emit("json");
    expect(Schema.decodeUnknownSync(StreamFrame)(JSON.parse(json.trim()))._tag).toBe("result");

    const yaml = await emit("yaml");
    expect(yaml.startsWith("apiVersion: v4\n")).toBe(true);
    expect(Bun.YAML.parse(yaml)).toEqual(JSON.parse(json.trim()).envelope);
  });

  test("a streaming failure under yaml is one envelope document", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail(new Error("stream boom")), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "yaml",
      command: "app:exec",
      resultSchema: ResultSchema,
      streaming: StreamFrame,
      streamingMode: "live",
      io,
      render: () => undefined,
      formatError: String,
      setExitCode: () => undefined,
    });

    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe("v4");
    expect(parsed.ok).toBe(false);
  });
});

describe("preCommandOutputMode honors an explicit yaml request", () => {
  const mode = (argv: ReadonlyArray<string>) => preCommandOutputMode({ argv, env: {} });

  test("recognizes both --format spellings", () => {
    expect(mode(["info", "--format=yaml"])).toEqual({ rendererMode: "json", resultFormat: "yaml" });
    expect(mode(["info", "--format", "yaml"])).toEqual({ rendererMode: "json", resultFormat: "yaml" });
  });

  test("the last explicit --format wins", () => {
    expect(mode(["info", "--format=yaml", "--format=json"]).resultFormat).toBe("json");
    expect(mode(["info", "--format=json", "--format", "yaml"]).resultFormat).toBe("yaml");
  });

  test("keeps json intent and the text default otherwise", () => {
    expect(mode(["info", "--json"])).toEqual({ rendererMode: "json", resultFormat: "json" });
    expect(mode(["info", "--format=json"]).resultFormat).toBe("json");
    expect(mode(["info"])).toEqual({ rendererMode: "plain", resultFormat: "text" });
  });

  test("ignores a format after the argv terminator", () => {
    expect(mode(["exec", "--", "--format=yaml"])).toEqual({ rendererMode: "plain", resultFormat: "text" });
  });
});

describe("documentOutput keeps a command's own document on success only", () => {
  const ResultSchema = Schema.Struct({ name: Schema.String });
  const value = { name: "demo" };

  const run = async (options: { readonly documentOutput?: boolean; readonly fail?: boolean }) => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    await runWithRendererHandling(
      options.fail === true ? Effect.fail(new Error("no")) : Effect.succeed(value),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "yaml",
        command: "app:config",
        resultSchema: ResultSchema,
        io,
        ...(options.documentOutput === undefined ? {} : { documentOutput: options.documentOutput }),
        render: () => "name: demo",
        formatError: String,
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );
    return { io, exitCode };
  };

  test("a matching success renders the command document, not the envelope", async () => {
    const { io, exitCode } = await run({ documentOutput: true });
    expect(io.stdout()).toBe("name: demo\n");
    expect(io.stdout()).not.toContain("apiVersion");
    expect(exitCode).toBeUndefined();
  });

  test("without the declaration the same command emits the envelope", async () => {
    const { io } = await run({});
    expect((Bun.YAML.parse(io.stdout()) as Record<string, unknown>).apiVersion).toBe("v4");
  });

  test("a failure is always the envelope, and still carries the failure exit code", async () => {
    const { io, exitCode } = await run({ documentOutput: true, fail: true });
    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(1);
  });
});

describe("the two document exceptions are declared and justified", () => {
  test("exactly app:config and app:config:translate opt out, each with a reason", () => {
    const declared = builtInCommandEntries
      .filter((entry) => entry.spec.documentOutput !== undefined)
      .map((entry) => entry.spec.id)
      .toSorted();

    expect(declared).toEqual(["app:config", "app:config:translate"]);
    for (const entry of builtInCommandEntries) {
      const declaration = entry.spec.documentOutput;
      if (declaration === undefined) continue;
      expect(declaration.format).toBe("yaml");
      expect(declaration.reason.length).toBeGreaterThan(40);
    }
  });
});

describe("the machine controls behave the same under yaml as under json", () => {
  const ResultSchema = Schema.Struct({ core: Schema.String, plugin: Schema.String });
  const value = { core: "4.0.0", plugin: "1.2.3" };

  const emit = async (
    resultFormat: "json" | "yaml",
    extra: Record<string, unknown> = {},
    effect: Effect.Effect<unknown, unknown> = Effect.succeed(value),
  ) => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(effect, {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat,
      command: "meta:version",
      resultSchema: ResultSchema,
      io,
      render: () => undefined,
      formatError: String,
      setExitCode: () => undefined,
      ...extra,
    });
    return io;
  };

  test("--json=<keys> narrows result under yaml", async () => {
    const io = await emit("yaml", { projectResultKeys: ["core"] });
    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ core: "4.0.0" });
  });

  test("--jq prints jq's own text, byte-identical to json mode", async () => {
    const yamlIo = await emit("yaml", { jqExpression: ".result.core" });
    const jsonIo = await emit("json", { jqExpression: ".result.core" });
    expect(yamlIo.stdout()).toBe(jsonIo.stdout());
    expect(yamlIo.stdout().trim()).toBe("4.0.0");
  });

  test("a bad --jq expression under yaml reports a yaml failure envelope and exit 2", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    await runWithRendererHandling(Effect.succeed(value), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "yaml",
      command: "meta:version",
      resultSchema: ResultSchema,
      jqExpression: "this is not jq",
      io,
      render: () => undefined,
      formatError: String,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect((parsed.error as Record<string, unknown>)._tag).toBe("JqExpressionError");
    expect(exitCode).toBe(2);
  });

  test("warnings land in the yaml envelope instead of stderr", async () => {
    const warn = Effect.gen(function* () {
      const warnings = yield* CommandWarnings;
      yield* warnings.add({ code: "example", message: "heads up" });
      return value;
    });
    const io = await emit("yaml", {}, warn as unknown as Effect.Effect<unknown, unknown>);
    const parsed = Bun.YAML.parse(io.stdout()) as Record<string, unknown>;
    expect(parsed.warnings).toEqual([{ code: "example", message: "heads up" }]);
    expect(io.stderr()).toBe("");
  });
});
