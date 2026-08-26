import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const TinyResultSchema = Schema.Struct({ name: Schema.String });

const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("runWithRendererHandling jqExpression", () => {
  test("prints the projected result name when jq selects .result.name", async () => {
    // Given a tiny struct result and --jq .result.name.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When the command succeeds under json machine output.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:info",
      resultSchema: TinyResultSchema,
      jqExpression: ".result.name",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then stdout is the raw scalar and the command exit stays 0.
    expect(io.stdout()).toBe("demo\n");
    expect(io.stderr()).toBe("");
    expect(exitCode).toBeUndefined();
    expect(process.exitCode).not.toBe(1);
    expect(process.exitCode).not.toBe(2);
  });

  test("projects result keys before jq runs on the envelope", async () => {
    // Given --json name plus --jq .result.name.
    const io = createBufferedRendererIO();

    // When the command succeeds with both projection and jq.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:info",
      resultSchema: TinyResultSchema,
      projectResultKeys: ["name"],
      jqExpression: ".result.name",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
    });

    // Then stdout is the projected name, not a full envelope.
    expect(io.stdout()).toBe("demo\n");
  });

  test("keeps the command failure exit code when jq succeeds on the failure envelope", async () => {
    // Given a failing command plus a valid jq expression.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When jq selects .ok from the failure envelope.
    await runWithRendererHandling(Effect.fail("nope"), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:start",
      resultSchema: TinyResultSchema,
      jqExpression: ".ok",
      io,
      formatError: (error) => `diagnostic: ${String(error)}`,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then jq output is written and the command failure code is kept.
    expect(io.stdout()).toBe("false\n");
    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(1);
  });

  test("keeps exit 0 when jq succeeds with empty output", async () => {
    // Given a successful command whose jq expression emits nothing.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When jq runs `empty` over the redacted envelope.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:info",
      resultSchema: TinyResultSchema,
      jqExpression: "empty",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then stdout has no envelope mix and the command exit stays 0.
    expect(io.stdout().includes("{")).toBe(false);
    expect(io.stderr()).toBe("");
    expect(exitCode).toBeUndefined();
    expect(process.exitCode).not.toBe(2);
  });

  test("exits 2 with JqExpressionError and does not mix envelope plus jq on stdout", async () => {
    // Given a successful command and a syntactically invalid jq expression.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When jq evaluation fails.
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:info",
      resultSchema: TinyResultSchema,
      jqExpression: "oops(",
      io,
      render: () => "should not render",
      formatError: () => "unexpected",
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    // Then the process is a usage error and stdout is not a half-written mix.
    expect(exitCode).toBe(2);
    const stdout = io.stdout();
    expect(stdout.includes("demo") && stdout.includes("oops(")).toBe(false);
    const firstLine = io.stdoutLines()[0];
    if (firstLine?.startsWith("{")) {
      const envelope = decodeEnvelope(firstLine);
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toMatchObject({ _tag: "JqExpressionError" });
    }
  });
});
