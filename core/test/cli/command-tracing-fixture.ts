import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect, Layer, Schema } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary";
import { resolveTrace } from "../../src/cli/trace-selection";

export const runTracingCommand = async (options: {
  readonly format?: "text" | "json" | "yaml";
  readonly endpoint?: string;
  readonly display?: boolean;
  readonly secret?: string;
  readonly failure?: boolean;
  readonly resultToken?: string;
  readonly onResult?: () => void;
}) => {
  const io = createBufferedRendererIO();
  const writes: string[] = [];
  let exitCode = 0;
  const trace = resolveTrace({
    argv: options.display === false ? [] : ["--trace"],
    env: { LANDO_CONFIG__appEnv__API_TOKEN: options.secret },
    config: {
      otlp: {
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        headers: { "x-team": "header-secret-669" },
      },
    },
  });
  const effect = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      envValue: options.secret ?? "public",
      flagValue: "flag-secret-669",
      headerValue: "header-secret-669",
      nonPrimitive: { nested: true },
      commandValue: options.resultToken ?? "public",
    });
    if (options.failure) return yield* Effect.die(new Error(`failure ${options.secret ?? "public"}`));
    return {
      message: `completed ${options.secret ?? "public"} flag-secret-669 ${options.resultToken ?? ""}`,
      redactionTokens: options.resultToken === undefined ? [] : [options.resultToken],
    };
  });
  await runWithRendererHandling(effect, {
    runtime: Layer.empty,
    io: {
      ...io,
      writeStdout: (chunk) => {
        writes.push(`stdout:${chunk}`);
        options.onResult?.();
        return io.writeStdout(chunk);
      },
      writeStderr: (chunk) => {
        writes.push(`stderr:${chunk}`);
        return io.writeStderr(chunk);
      },
    },
    rendererMode: "plain",
    resultFormat: options.format ?? "text",
    command: "meta:probe",
    resultSchema: Schema.Struct({ message: Schema.String }),
    invocation: {
      commandId: "meta:probe",
      argv: [],
      flags: { password: "flag-secret-669" },
      args: {},
      cwd: "/workspace",
    },
    trace,
    redactionTokens: (result) => result.redactionTokens,
    render: (result) => result.message,
    formatError: String,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { io, writes, exitCode };
};
