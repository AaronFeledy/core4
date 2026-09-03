import { Effect, Layer, Option, type Scope, Stream } from "effect";

import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type CommandSpec,
  type ExecChunk,
  type ProviderError,
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { withAgentContextEnv } from "../config/agent-env.ts";
import { StreamFrameSink, type StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import { resolveContainerCwd } from "../subsystems/host-proxy/cwd-remap.ts";

const findPrimary = (services: AppPlan["services"]): ReadonlyArray<ServicePlan> =>
  Object.values(services).filter((service) => service.primary === true);

const availableServiceList = (services: AppPlan["services"]) =>
  Object.values(services)
    .map((service) => service.name)
    .sort()
    .join(", ");

export const noCommandsError = (tool: string): ToolingExecError =>
  new ToolingExecError({
    message: `Tooling task ${tool} has no commands to run.`,
    tool,
  });

const noPrimaryServiceError = (tool: string, services: AppPlan["services"]) => {
  const available = availableServiceList(services);
  return new ToolingExecError({
    message: `Tooling task ${tool} did not declare service: and the app has no primary service. Set service: on the task or mark one of the available services as primary${available.length === 0 ? "." : `: ${available}.`}`,
    tool,
  });
};

const unknownServiceError = (tool: string, requested: string, services: AppPlan["services"]) => {
  const available = availableServiceList(services);
  return new ToolingExecError({
    message: `Tooling task ${tool} declared service: ${requested} but no such service exists in the app plan${available.length === 0 ? "." : ` (available: ${available}).`}`,
    tool,
  });
};

const resolveService = (
  invocation: ToolingInvocation,
  plan: AppPlan,
): Effect.Effect<ServicePlan, ToolingExecError> => {
  if (invocation.service !== undefined) {
    const matching = Object.values(plan.services).find((service) => service.name === invocation.service);
    if (matching === undefined) {
      return Effect.fail(unknownServiceError(invocation.tool, invocation.service, plan.services));
    }
    return Effect.succeed(matching);
  }
  const [primary] = findPrimary(plan.services);
  if (primary === undefined) {
    return Effect.fail(noPrimaryServiceError(invocation.tool, plan.services));
  }
  return Effect.succeed(primary);
};

const idleStdin = (): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    let stopped = false;
    let waiting: ((result: IteratorResult<Uint8Array>) => void) | undefined;
    return {
      next: () => {
        if (stopped) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<Uint8Array>>((resolve) => {
          waiting = resolve;
        });
      },
      return: async () => {
        stopped = true;
        waiting?.({ done: true, value: undefined });
        return { done: true as const, value: undefined };
      },
    };
  },
});

const envOrFallback = (name: "COLUMNS" | "LINES" | "TERM", fallback: string): string => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
};

const hostTerm = (): string => {
  const term = envOrFallback("TERM", "xterm-256color");
  return term === "dumb" ? "xterm-256color" : term;
};

const execSpec = (input: {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly tty: boolean;
}): CommandSpec => {
  // Podman rejects POST /exec/{id}/resize until the session has started, so
  // tooling never sends terminalSize. A PTY still needs stdin attached or PHP
  // will not see a TTY and Composer will print progress on new lines.
  const ttyEnv = input.tty
    ? {
        COLUMNS: envOrFallback("COLUMNS", "80"),
        LINES: envOrFallback("LINES", "24"),
        TERM: hostTerm(),
      }
    : undefined;
  const merged = input.env === undefined && ttyEnv === undefined ? undefined : { ...ttyEnv, ...input.env };
  const env =
    merged === undefined
      ? undefined
      : input.tty
        ? Object.fromEntries(Object.entries(merged).filter(([name]) => name !== "CI"))
        : merged;
  return {
    command: input.command,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(input.tty ? { tty: true, stdin: "inherit", stdinStream: idleStdin() } : {}),
  };
};

type StreamSink = StreamFrameSinkShape;

const emitRaw = (
  sink: Option.Option<StreamSink>,
  kind: "stdout" | "stderr",
  text: string,
): Effect.Effect<void> => {
  if (text.length === 0 || Option.isNone(sink)) return Effect.void;
  return sink.value.emit({ _tag: kind, chunk: text, raw: true });
};

const collectExecStream = (
  stream: Stream.Stream<ExecChunk, ProviderError, Scope.Scope>,
  sink: Option.Option<StreamSink>,
): Effect.Effect<
  { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  ProviderError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      yield* stream.pipe(
        Stream.runForEach((chunk) => {
          if ("exitCode" in chunk) {
            exitCode = chunk.exitCode;
            return Effect.void;
          }
          const decoder = chunk.kind === "stdout" ? stdoutDecoder : stderrDecoder;
          const text = decoder.decode(chunk.chunk, { stream: true });
          if (chunk.kind === "stdout") stdout += text;
          else stderr += text;
          return emitRaw(sink, chunk.kind, text);
        }),
      );
      const stdoutTail = stdoutDecoder.decode();
      const stderrTail = stderrDecoder.decode();
      stdout += stdoutTail;
      stderr += stderrTail;
      yield* emitRaw(sink, "stdout", stdoutTail);
      yield* emitRaw(sink, "stderr", stderrTail);
      return { exitCode, stdout, stderr };
    }),
  );

const providerExecRun = (invocation: ToolingInvocation, plan: AppPlan, provider: RuntimeProviderShape) =>
  Effect.gen(function* () {
    if (invocation.commands.length === 0) {
      return yield* Effect.fail(noCommandsError(invocation.tool));
    }
    const service = yield* resolveService(invocation, plan);
    const cwd = resolveContainerCwd(service, invocation.cwd, process.cwd());
    const env = withAgentContextEnv(invocation.env, process.env, {
      lowerThanEnv: service.environment,
      ...(invocation.agentEnvAllowlist === undefined ? {} : { allowlist: invocation.agentEnvAllowlist }),
    });
    const sink = yield* Effect.serviceOption(StreamFrameSink);
    const tty = Option.isSome(sink);
    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    for (const command of invocation.commands) {
      const target = {
        app: plan.id,
        service: service.name,
        plan,
        ...(invocation.user === undefined ? {} : { user: invocation.user }),
      };
      const result = yield* collectExecStream(
        provider.execStream(target, execSpec({ command, cwd, env, tty })),
        sink,
      );
      stdout += result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
      if (exitCode !== 0) break;
    }
    const out: ToolingEngineResult = {
      tool: invocation.tool,
      service: service.name,
      exitCode,
      stdout,
      stderr,
    };
    return out;
  });

export const ProviderExecToolingEngineLive = Layer.succeed(ToolingEngine, {
  id: "providerExec",
  run: providerExecRun,
});
