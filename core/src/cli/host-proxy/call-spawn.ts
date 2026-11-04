import { hostProxyWorkerEntry } from "@lando/engine/composition";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import type {
  HostProxyOpenCallExecutor,
  HostProxyRunLandoExecutor,
  HostProxyRunLandoExecutorInput,
} from "@lando/engine/subsystems/host-proxy/dispatch";
import { filterHostProxyEnv } from "@lando/engine/subsystems/host-proxy/shim";
import { hostProxyWorkerArgv } from "@lando/engine/subsystems/host-proxy/worker-process";
import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, HostProxyResponse } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Schema, Stream } from "effect";
import { HOST_PROXY_CALL_COMMAND, type HostProxyCall } from "./call-context";
import type { WorkerInput } from "./worker-config";

export const hostProxyChildEnv = (
  startup: Readonly<Record<string, string | undefined>>,
  paths: typeof WorkerInput.Type.paths,
  forwarded: Readonly<Record<string, string>>,
  depth: number,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(startup).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].toUpperCase().startsWith("LANDO_HOST_PROXY_") &&
        !["BUN_BE_BUN", "BUN_FEATURE_FLAG_NO_ORPHANS"].includes(entry[0].toUpperCase()),
    ),
  ),
  LANDO_USER_CONF_ROOT: paths.userConfRoot,
  LANDO_USER_CACHE_ROOT: paths.userCacheRoot,
  LANDO_USER_DATA_ROOT: paths.userDataRoot,
  LANDO_SYSTEM_PLUGIN_ROOT: paths.systemPluginRoot,
  ...filterHostProxyEnv(forwarded),
  LANDO_HOST_PROXY_DEPTH: String(depth + 1),
});

const childExecutor = (
  input: typeof WorkerInput.Type,
  prefix: readonly string[] = hostProxyWorkerArgv(hostProxyWorkerEntry()).slice(0, -1),
) => {
  const startup = { ...process.env };
  return Effect.fnUntraced(
    function* (envelope: HostProxyCall, output?: HostProxyRunLandoExecutorInput["output"]) {
      const runner = yield* ProcessRunner;
      const stdinStream: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
          await new Promise<never>(() => undefined);
        },
      };
      const decoders = {
        stdout: new TextDecoder("utf-8", { fatal: true }),
        stderr: new TextDecoder("utf-8", { fatal: true }),
      };
      let stdout = "";
      let stderr = "";
      let exitCode = 1;
      yield* runner
        .streamWithExit({
          cmd: prefix[0] ?? process.execPath,
          args: [...prefix.slice(1), HOST_PROXY_CALL_COMMAND],
          cwd: input.app.root,
          env: hostProxyChildEnv(
            startup,
            input.paths,
            envelope.operation === "runLando" ? envelope.env : {},
            envelope.depth,
          ),
          replaceEnv: true,
          stdinStream,
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.tryPromise(async () => {
              if ("kind" in event) {
                const chunk = decoders[event.kind].decode(event.chunk, { stream: true });
                if (output !== undefined) {
                  if (chunk !== "") await output(event.kind, chunk);
                } else if (event.kind === "stdout") stdout += chunk;
                else stderr += chunk;
              } else {
                exitCode = event.exitCode;
                for (const kind of ["stdout", "stderr"] as const) {
                  const chunk = decoders[kind].decode();
                  if (output !== undefined) {
                    if (chunk !== "") await output(kind, chunk);
                  } else if (kind === "stdout") stdout += chunk;
                  else stderr += chunk;
                }
              }
            }),
          ),
        );
      return { stdout, stderr, exitCode };
    },
    Effect.provide(BunProcessRunner.layer),
    Effect.mapError(
      () =>
        new HostProxyTransportUnavailableError({
          message: "Host-proxy child execution failed.",
          socketPath: "host-proxy-worker",
          remediation: "Retry the command and inspect the host-proxy worker log.",
        }),
    ),
  );
};

export const hostProxyChildExecutor = (
  input: typeof WorkerInput.Type,
  prefix?: readonly string[],
): HostProxyRunLandoExecutor => {
  const execute = childExecutor(input, prefix);
  return (request) =>
    execute(
      {
        operation: "runLando",
        argv: request.argv,
        env: filterHostProxyEnv(request.env),
        app: { ...input.app, root: AbsolutePath.make(input.app.root) },
        mount: request.mount ?? { containerRoot: "/app", hostRoot: input.plan.root },
        cwd: request.containerCwd ?? "/app",
        callId: request.callId ?? crypto.randomUUID(),
        depth: request.depth ?? 0,
        callerService: request.callerService ?? "unknown",
      },
      request.output,
    );
};

export const hostProxyChildOpenExecutor = (
  input: typeof WorkerInput.Type,
  prefix?: readonly string[],
): HostProxyOpenCallExecutor => {
  const execute = childExecutor(input, prefix);
  return (request, context) =>
    execute({
      ...(request._tag === "openUrl"
        ? { operation: "openUrl" as const, url: request.url }
        : { operation: "openPath" as const, path: request.path }),
      app: { ...input.app, root: AbsolutePath.make(input.app.root) },
      mount: context.mountInfo,
      cwd: context.mountInfo.containerRoot,
      callId: context.callId ?? crypto.randomUUID(),
      depth: context.depth,
      callerService: context.callerService,
    }).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(HostProxyResponse))(result.stdout),
      ),
      Effect.mapError(
        () =>
          new HostProxyTransportUnavailableError({
            message: "Host-proxy open child returned an invalid response.",
            socketPath: "host-proxy-worker",
            remediation: "Retry the call and inspect the host-proxy worker log.",
          }),
      ),
    );
};
