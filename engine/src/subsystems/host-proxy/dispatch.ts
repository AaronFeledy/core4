import { RedactionService } from "@lando/redaction/service";
import { HostProxyCommandNotAllowedError, type HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "@lando/sdk/events";
import type { AppRef, HostProxyResponse, HostProxyRunLandoRequest } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Cause, Clock, DateTime, Effect, Exit, Option } from "effect";
import { type HostProxyMountInfo, remapContainerCwd } from "./cwd-remap.ts";
import type { HostProxyOpenExecutor, HostProxyOpenRequest } from "./open-target.ts";
import { filterHostProxyEnv } from "./shim.ts";

export interface HostProxyRunLandoExecutorInput {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly tty: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly app?: AppRef;
  readonly mount?: HostProxyMountInfo;
  readonly containerCwd?: string;
  readonly callId?: string;
  readonly depth?: number;
  readonly callerService?: string;
  readonly output?: (kind: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface HostProxyRunLandoResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type HostProxyRunLandoExecutor = (
  input: HostProxyRunLandoExecutorInput,
) => Effect.Effect<HostProxyRunLandoResult, HostProxyTransportUnavailableError>;

export interface DispatchRunLandoDeps {
  readonly executor: HostProxyRunLandoExecutor;
  readonly allowlist: ReadonlyArray<string>;
  readonly mountInfo: HostProxyMountInfo;
  readonly callerService: string;
  readonly depth: number;
  readonly app: AppRef;
  readonly callId?: string;
  readonly output?: HostProxyRunLandoExecutorInput["output"];
}

export type HostProxyOpenCallContext = Pick<
  DispatchRunLandoDeps,
  "mountInfo" | "callerService" | "depth" | "app" | "callId"
>;
export type HostProxyOpenCallExecutor = (
  request: HostProxyOpenRequest,
  context: HostProxyOpenCallContext,
) => Effect.Effect<HostProxyResponse, HostProxyTransportUnavailableError>;

export const dispatchRunLando = Effect.fn("HostProxy.dispatchRunLando")(function* (
  request: HostProxyRunLandoRequest,
  deps: DispatchRunLandoDeps,
) {
  const head = request.argv[0] ?? "";
  const commandId = head === "open" ? "app:open" : head;
  if (!head.startsWith("-") && head !== "help" && !deps.allowlist.includes(commandId))
    return yield* Effect.fail(
      new HostProxyCommandNotAllowedError({
        message: "This command is not on the host-proxy runLando allowlist.",
        commandId,
        effectiveAllowlist: [...deps.allowlist],
        remediation: "Use an allowlisted built-in command.",
      }),
    );
  return yield* deps.executor({
    commandId,
    argv: request.argv,
    cwd: remapContainerCwd(request.cwd, deps.mountInfo),
    tty: false,
    env: { ...filterHostProxyEnv(request.env ?? {}), LANDO_HOST_PROXY_DEPTH: String(deps.depth + 1) },
    app: deps.app,
    mount: deps.mountInfo,
    containerCwd: request.cwd,
    depth: deps.depth,
    callerService: deps.callerService,
    ...(deps.callId === undefined ? {} : { callId: deps.callId }),
    ...(deps.output === undefined ? {} : { output: deps.output }),
  });
});

export const dispatchHostOpen = Effect.fn("HostProxy.dispatchOpen")(function* <R>(
  request: HostProxyOpenRequest,
  deps: Omit<DispatchRunLandoDeps, "executor" | "allowlist"> & {
    readonly executor: HostProxyOpenExecutor<R>;
  },
) {
  const events = yield* EventService;
  const redaction = yield* RedactionService;
  const target = request._tag === "openUrl" ? request.url : request.path;
  const redactor = yield* redaction.forProfile("secrets", {
    sourceEnv: process.env,
    authoritativeTokens: [target],
  });
  const start = yield* Clock.currentTimeMillis;
  const common = {
    app: deps.app,
    callId: deps.callId ?? `hp-${start}-${Math.random().toString(36).slice(2, 10)}`,
    request: { kind: request._tag, argvSummary: [redactor.redactString(target)] },
    callerService: redactor.redactString(deps.callerService),
    depth: deps.depth,
  };
  yield* events.publish(PreHostProxyCallEvent.make({ ...common, timestamp: yield* DateTime.now }));
  return yield* deps.executor(request, deps.mountInfo).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        yield* events.publish(
          PostHostProxyCallEvent.make({
            ...common,
            timestamp: yield* DateTime.now,
            durationMs: (yield* Clock.currentTimeMillis) - start,
            outcome: Exit.isSuccess(exit) ? "success" : "failure",
            ...(failure === undefined ? {} : { failureDetail: failure._tag }),
          }),
        );
      }),
    ),
  );
});
