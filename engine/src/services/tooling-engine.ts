import { Effect, Layer } from "effect";

import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type CommandSpec,
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingEngineResult,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { withAgentContextEnv } from "../config/agent-env.ts";
import { withTerminalEnv } from "../config/terminal-env.ts";
import { collectExecStream } from "../operations/exec-stream.ts";
import { StreamFrameSink } from "../operations/stream-frame-sink.ts";
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

const execSpec = (input: {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly tty: boolean;
  readonly hostTerminal: ToolingInvocation["hostTerminal"];
  readonly stdinStream: ToolingInvocation["stdinStream"];
  readonly terminalResize: ToolingInvocation["terminalResize"];
  readonly signal: ToolingInvocation["signal"];
  readonly serviceEnv: ServicePlan["environment"];
}): CommandSpec => {
  // A PTY without a forwarded keyboard cannot dismiss a pager. Default only
  // that case to cat, without overriding service or task env.
  const merged = withTerminalEnv({
    tty: input.tty,
    hostEnv: process.env,
    ...(input.hostTerminal === undefined ? {} : { hostTerminal: input.hostTerminal }),
    serviceEnv: input.serviceEnv,
    env: {
      ...(input.tty && input.stdinStream === undefined && input.serviceEnv.PAGER === undefined
        ? { PAGER: "cat" }
        : {}),
      ...input.env,
    },
  });
  const env =
    merged === undefined
      ? undefined
      : input.tty && input.hostTerminal !== undefined
        ? Object.fromEntries(Object.entries(merged).filter(([name]) => name !== "CI"))
        : merged;
  return {
    command: input.command,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(input.tty ? { tty: true, stdin: "inherit", stdinStream: input.stdinStream ?? idleStdin() } : {}),
    ...(input.terminalResize === undefined ? {} : { terminalResize: input.terminalResize }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.tty && input.hostTerminal?.columns !== undefined && input.hostTerminal.rows !== undefined
      ? { terminalSize: { columns: input.hostTerminal.columns, rows: input.hostTerminal.rows } }
      : {}),
  };
};

const providerExecRun = Effect.fn("ToolingEngine.run")(function* (
  invocation: ToolingInvocation,
  plan: AppPlan,
  provider: RuntimeProviderShape,
) {
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
  const tty = invocation.tty === true;
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
      provider.execStream(
        target,
        execSpec({
          command,
          cwd,
          env,
          tty,
          hostTerminal: invocation.hostTerminal,
          stdinStream: invocation.stdinStream,
          terminalResize: invocation.terminalResize,
          signal: invocation.signal,
          serviceEnv: service.environment,
        }),
      ),
      sink,
    );
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = invocation.signal?.aborted === true ? 130 : result.exitCode;
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

export const layer = Layer.succeed(
  ToolingEngine,
  ToolingEngine.of({
    id: "providerExec",
    run: providerExecRun,
  }),
);
